// Sync S1 (#110): fetchGitPack derives the update channel (pinned|tag|branch)
// and exposes resolveGitSourceSha so `agentpack update --check` can re-resolve
// a recorded source. Base URLs are overridable via env so tests and the e2e
// gate can point at a local mock GitHub server.
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as gitSource from "../src/git-source/index.js";

const PINNED_SHA = "deadbeefcafe1234567890abcdef1234567890ab";

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

/**
 * Mock fetch for owner test-owner/test-repo. `isTag` controls whether the
 * git/ref/tags probe recognizes the ref; `calls` records every URL hit.
 */
function makeMockFetch(opts: { ref: string; isTag: boolean; calls?: string[] }) {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    opts.calls?.push(url);
    const respond = (body: string, status = 200) => new Response(body, { status });
    if (url === "https://api.github.com/repos/test-owner/test-repo") {
      return respond(JSON.stringify({ default_branch: "main" }));
    }
    if (
      url ===
      `https://api.github.com/repos/test-owner/test-repo/git/ref/tags/${encodeURIComponent(opts.ref)}`
    ) {
      return opts.isTag
        ? respond(JSON.stringify({ ref: `refs/tags/${opts.ref}` }))
        : respond("not found", 404);
    }
    if (url.startsWith("https://api.github.com/repos/test-owner/test-repo/commits/")) {
      return respond(JSON.stringify({ sha: PINNED_SHA }));
    }
    if (
      url ===
      `https://api.github.com/repos/test-owner/test-repo/git/trees/${PINNED_SHA}?recursive=1`
    ) {
      return respond(
        JSON.stringify({
          truncated: false,
          tree: [
            { path: "AGENTPACK.yaml", type: "blob" },
            { path: "docs/notes.md", type: "blob" },
          ],
        }),
      );
    }
    if (
      url ===
      `https://raw.githubusercontent.com/test-owner/test-repo/${PINNED_SHA}/AGENTPACK.yaml`
    ) {
      return respond(manifestYaml);
    }
    if (
      url ===
      `https://raw.githubusercontent.com/test-owner/test-repo/${PINNED_SHA}/docs/notes.md`
    ) {
      return respond("# Notes");
    }
    return respond("not found", 404);
  }) as typeof fetch;
}

async function fetchWith(opts: {
  ref: string | null;
  isTag: boolean;
  calls?: string[];
}): Promise<gitSource.FetchGitPackResult> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-git-chan-"));
  try {
    return await gitSource.fetchGitPack({
      source: {
        host: "github",
        owner: "test-owner",
        repo: "test-repo",
        ref: opts.ref,
        subpath: null,
      },
      tmpRootHint: tmpRoot,
      fetchImpl: makeMockFetch({
        ref: opts.ref ?? "main",
        isTag: opts.isTag,
        calls: opts.calls,
      }),
    });
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

describe("fetchGitPack channel derivation", () => {
  it("classifies a 40-hex ref as pinned without probing the tags endpoint", async () => {
    const calls: string[] = [];
    const out = await fetchWith({ ref: PINNED_SHA, isTag: false, calls });
    expect(out.channel).toBe("pinned");
    expect(calls.some((u) => u.includes("/git/ref/tags/"))).toBe(false);
  });

  it("classifies a ref the tags endpoint recognizes as tag", async () => {
    const out = await fetchWith({ ref: "v0.1.0", isTag: true });
    expect(out.channel).toBe("tag");
  });

  it("classifies a ref the tags endpoint 404s as branch", async () => {
    const out = await fetchWith({ ref: "main", isTag: false });
    expect(out.channel).toBe("branch");
  });

  it("classifies an omitted ref (default branch) as branch without probing tags", async () => {
    const calls: string[] = [];
    const out = await fetchWith({ ref: null, isTag: false, calls });
    expect(out.channel).toBe("branch");
    expect(out.requestedRef).toBeNull();
    expect(calls.some((u) => u.includes("/git/ref/tags/"))).toBe(false);
  });
});

describe("resolveGitSourceSha", () => {
  it("re-resolves an explicit ref to its current SHA", async () => {
    const sha = await gitSource.resolveGitSourceSha(
      {
        host: "github",
        owner: "test-owner",
        repo: "test-repo",
        ref: "main",
        subpath: null,
      },
      makeMockFetch({ ref: "main", isTag: false }),
    );
    expect(sha).toBe(PINNED_SHA);
  });

  it("resolves the default branch when ref is null", async () => {
    const sha = await gitSource.resolveGitSourceSha(
      { host: "github", owner: "test-owner", repo: "test-repo", ref: null, subpath: null },
      makeMockFetch({ ref: "main", isTag: false }),
    );
    expect(sha).toBe(PINNED_SHA);
  });
});

describe("base URL env overrides", () => {
  afterEach(() => {
    delete process.env["AGENTPACK_GITHUB_API_URL"];
    delete process.env["AGENTPACK_GITHUB_RAW_URL"];
  });

  it("AGENTPACK_GITHUB_API_URL redirects API calls to the override host", async () => {
    process.env["AGENTPACK_GITHUB_API_URL"] = "http://127.0.0.1:9/api";
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ sha: PINNED_SHA }), { status: 200 });
    }) as typeof fetch;
    const sha = await gitSource.resolveGitSourceSha(
      { host: "github", owner: "o", repo: "r", ref: "main", subpath: null },
      fetchImpl,
    );
    expect(sha).toBe(PINNED_SHA);
    expect(calls[0]).toBe("http://127.0.0.1:9/api/repos/o/r/commits/main");
  });
});

describe("token gating under base URL overrides", () => {
  afterEach(() => {
    delete process.env["AGENTPACK_GITHUB_API_URL"];
    delete process.env["AGENTPACK_GITHUB_TOKEN_ALLOW_OVERRIDE"];
    delete process.env["GITHUB_TOKEN"];
  });

  it("does NOT attach GITHUB_TOKEN when an override is active (default)", async () => {
    process.env["AGENTPACK_GITHUB_API_URL"] = "http://127.0.0.1:9";
    process.env["GITHUB_TOKEN"] = "ghp_realtoken";
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined);
      return new Response(JSON.stringify({ sha: PINNED_SHA }), { status: 200 });
    }) as typeof fetch;
    await gitSource.resolveGitSourceSha(
      { host: "github", owner: "o", repo: "r", ref: "main", subpath: null },
      fetchImpl,
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) {
      expect(h?.["Authorization"]).toBeUndefined();
    }
  });

  it("attaches the token under an override only with AGENTPACK_GITHUB_TOKEN_ALLOW_OVERRIDE=1", async () => {
    process.env["AGENTPACK_GITHUB_API_URL"] = "http://127.0.0.1:9";
    process.env["GITHUB_TOKEN"] = "ghp_realtoken";
    process.env["AGENTPACK_GITHUB_TOKEN_ALLOW_OVERRIDE"] = "1";
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string> | undefined);
      return new Response(JSON.stringify({ sha: PINNED_SHA }), { status: 200 });
    }) as typeof fetch;
    await gitSource.resolveGitSourceSha(
      { host: "github", owner: "o", repo: "r", ref: "main", subpath: null },
      fetchImpl,
    );
    expect(seen[0]?.["Authorization"]).toBe("Bearer ghp_realtoken");
  });
});
