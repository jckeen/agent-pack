/**
 * Tests for `parseGitId` and `fetchGitPack`.
 *
 * `parseGitId` is a pure parser — table-driven tests.
 * `fetchGitPack` is tested with a mock fetch so the suite stays offline.
 */

import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  fetchGitPack,
  parseGitId,
  type GitSource,
} from "../src/git-source/index.js";

describe("parseGitId", () => {
  it("parses `github:owner/repo@tag`", () => {
    expect(parseGitId("github:foo/bar@v1.0.0")).toEqual({
      host: "github",
      owner: "foo",
      repo: "bar",
      ref: "v1.0.0",
      subpath: null,
    } satisfies GitSource);
  });

  it("parses `github:owner/repo@tag#subpath`", () => {
    expect(parseGitId("github:foo/bar@v1.0.0#examples/pr-quality")).toEqual({
      host: "github",
      owner: "foo",
      repo: "bar",
      ref: "v1.0.0",
      subpath: "examples/pr-quality",
    });
  });

  it("parses `github.com/owner/repo` with no ref (default branch)", () => {
    expect(parseGitId("github.com/foo/bar")).toEqual({
      host: "github.com",
      owner: "foo",
      repo: "bar",
      ref: null,
      subpath: null,
    });
  });

  it("parses `github.com/owner/repo@sha`", () => {
    expect(parseGitId("github.com/foo/bar@a91c066")).toEqual({
      host: "github.com",
      owner: "foo",
      repo: "bar",
      ref: "a91c066",
      subpath: null,
    });
  });

  it("strips trailing `.git`", () => {
    expect(parseGitId("github:foo/bar.git@v1.0.0")).toEqual({
      host: "github",
      owner: "foo",
      repo: "bar",
      ref: "v1.0.0",
      subpath: null,
    });
  });

  it("returns null for bare registry-id (no `github:` prefix)", () => {
    expect(parseGitId("publisher/pack")).toBeNull();
    expect(parseGitId("publisher/pack@1.0.0")).toBeNull();
  });

  it("returns null for invalid slugs", () => {
    expect(parseGitId("github:bad slug!/repo")).toBeNull();
    expect(parseGitId("")).toBeNull();
    expect(parseGitId("just-a-string")).toBeNull();
  });

  it("accepts branch refs with slashes", () => {
    expect(parseGitId("github:foo/bar@release/v1")).toEqual({
      host: "github",
      owner: "foo",
      repo: "bar",
      ref: "release/v1",
      subpath: null,
    });
  });
});

describe("fetchGitPack — mocked fetch", () => {
  const manifestYaml = `agentpack: "1.0"
metadata:
  id: example.pack
  name: Example pack
  version: 0.1.0
  publisher: example
  tags: []
  compatibilities: []
atoms:
  - id: notes
    type: context_pack
    files:
      - path: docs/notes.md
        sha256: "n/a"
profiles:
  safe:
    include: [notes]
exports:
  default_profile: safe
compatibility:
  targets:
    generic:
      status: full
`;

  function makeMockFetch(): typeof fetch {
    const responses = new Map<string, { ok: boolean; status: number; body: string }>([
      [
        "https://raw.githubusercontent.com/test-owner/test-repo/v0.1.0/AGENTPACK.yaml",
        { ok: true, status: 200, body: manifestYaml },
      ],
      [
        "https://raw.githubusercontent.com/test-owner/test-repo/v0.1.0/docs/notes.md",
        { ok: true, status: 200, body: "# Notes\nHello from git source." },
      ],
    ]);

    return (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const r = responses.get(url);
      if (!r) {
        return new Response("not found", { status: 404 });
      }
      return new Response(r.body, { status: r.status });
    }) as typeof fetch;
  }

  it("fetches the manifest + atom files into a tmpRoot", async () => {
    const tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "wgpack-git-test-")
    );
    const out = await fetchGitPack({
      source: {
        host: "github",
        owner: "test-owner",
        repo: "test-repo",
        ref: "v0.1.0",
        subpath: null,
      },
      tmpRootHint: tmpRoot,
      fetchImpl: makeMockFetch(),
    });

    expect(out).toBe(tmpRoot);
    const manifestOnDisk = await fs.readFile(
      path.join(tmpRoot, "AGENTPACK.yaml"),
      "utf-8"
    );
    expect(manifestOnDisk).toContain("agentpack:");
    const noteOnDisk = await fs.readFile(
      path.join(tmpRoot, "docs/notes.md"),
      "utf-8"
    );
    expect(noteOnDisk).toBe("# Notes\nHello from git source.");

    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("rejects manifest path traversal at the boundary", async () => {
    const traversalManifest = `agentpack: "1.0"
metadata:
  id: bad.pack
  name: Bad
  version: 0.1.0
  publisher: bad
  tags: []
  compatibilities: []
atoms:
  - id: malicious
    type: context_pack
    files:
      - path: ../../etc/passwd
        sha256: "n/a"
profiles: { safe: { include: [malicious] } }
exports: { default_profile: safe }
compatibility: { targets: {} }
`;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("AGENTPACK.yaml")) {
        return new Response(traversalManifest, { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "wgpack-git-trav-")
    );

    await expect(
      fetchGitPack({
        source: {
          host: "github",
          owner: "x",
          repo: "y",
          ref: "main",
          subpath: null,
        },
        tmpRootHint: tmpRoot,
        fetchImpl,
      })
    ).rejects.toThrow(/traversal|absolute root/);

    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("404 on manifest fetch surfaces a clear error", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as typeof fetch;

    const tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "wgpack-git-404-")
    );
    await expect(
      fetchGitPack({
        source: {
          host: "github",
          owner: "ghost",
          repo: "missing",
          ref: "main",
          subpath: null,
        },
        tmpRootHint: tmpRoot,
        fetchImpl,
      })
    ).rejects.toThrow(/returned 404|confirm the ref/);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
});
