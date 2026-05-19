import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  HttpRegistryClient,
  InMemoryRegistryClient,
  IntegrityError,
  makeFixture,
  RegistryError,
  resolveLatestVersion,
  VersionNotFoundError,
} from "../src/registry-client/index.js";
import type {
  RegistryPack,
  RegistryVersion,
} from "../src/protocol/index.js";

const sample: RegistryPack = {
  publisher: "workgraph",
  pack: "pr-quality",
  description: "PR quality pack",
  tags: ["github"],
  versions: [
    { version: "0.1.0", publishedAt: "2026-01-01T00:00:00Z", status: "published" },
  ],
  latestVersion: "0.1.0",
};

const sampleVersion: RegistryVersion = {
  publisher: "workgraph",
  pack: "pr-quality",
  version: "0.1.0",
  status: "published",
  manifestSha256: "a".repeat(64),
  publishedAt: "2026-01-01T00:00:00Z",
  files: [],
};

describe("resolveLatestVersion", () => {
  it("picks highest stable over prerelease", () => {
    expect(resolveLatestVersion(["1.0.0", "1.2.0", "1.2.0-beta.1"])).toBe("1.2.0");
  });
  it("ignores prerelease when stable exists", () => {
    expect(resolveLatestVersion(["0.1.0", "0.2.0-rc.1"])).toBe("0.1.0");
  });
  it("returns null if only prereleases", () => {
    expect(resolveLatestVersion(["0.1.0-rc.1", "0.1.0-rc.2"])).toBeNull();
  });
  it("returns null on empty list", () => {
    expect(resolveLatestVersion([])).toBeNull();
  });
  it("handles many versions", () => {
    expect(
      resolveLatestVersion(["1.0.0", "1.1.0", "0.9.9", "2.0.0", "1.5.3"])
    ).toBe("2.0.0");
  });
});

describe("InMemoryRegistryClient", () => {
  it("listVersions returns fixture pack", async () => {
    const fixture = makeFixture();
    fixture.packs.set("workgraph/pr-quality", sample);
    const client = new InMemoryRegistryClient(fixture);
    expect(await client.listVersions("workgraph", "pr-quality")).toEqual(sample);
  });
  it("listVersions throws VersionNotFoundError on miss", async () => {
    const client = new InMemoryRegistryClient(makeFixture());
    await expect(client.listVersions("x", "y")).rejects.toBeInstanceOf(
      VersionNotFoundError
    );
  });
  it("fetchAtomFile verifies sha256", async () => {
    const fixture = makeFixture();
    const bytes = Buffer.from("atom-body");
    const sha = createHash("sha256").update(bytes).digest("hex");
    fixture.blobs.set("workgraph/pr-quality@0.1.0/skill/SKILL.md", bytes);
    const client = new InMemoryRegistryClient(fixture);
    const got = await client.fetchAtomFile(
      "workgraph",
      "pr-quality",
      "0.1.0",
      "skill",
      "SKILL.md",
      sha
    );
    expect(got.equals(bytes)).toBe(true);
  });
  it("fetchAtomFile rejects sha mismatch", async () => {
    const fixture = makeFixture();
    fixture.blobs.set(
      "workgraph/pr-quality@0.1.0/skill/SKILL.md",
      Buffer.from("real-bytes")
    );
    const client = new InMemoryRegistryClient(fixture);
    await expect(
      client.fetchAtomFile(
        "workgraph",
        "pr-quality",
        "0.1.0",
        "skill",
        "SKILL.md",
        "f".repeat(64)
      )
    ).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe("HttpRegistryClient", () => {
  const baseUrl = "https://registry.example.com";

  function mockFetch(
    handler: (url: string, init?: RequestInit) => Promise<Response>
  ): typeof fetch {
    return ((url: string, init?: RequestInit) =>
      handler(String(url), init)) as unknown as typeof fetch;
  }

  it("listVersions 200 happy path", async () => {
    const fetchImpl = mockFetch(async (url) => {
      expect(url).toBe(`${baseUrl}/api/packs/workgraph/pr-quality`);
      return new Response(JSON.stringify(sample), { status: 200 });
    });
    const client = new HttpRegistryClient({ baseUrl, fetchImpl });
    expect(await client.listVersions("workgraph", "pr-quality")).toEqual(sample);
  });

  it("sends Authorization when token provided", async () => {
    const fetchImpl = mockFetch(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer wgp_live_xxxxxxxx");
      return new Response(JSON.stringify(sample), { status: 200 });
    });
    const client = new HttpRegistryClient({
      baseUrl,
      token: "wgp_live_xxxxxxxx",
      fetchImpl,
    });
    await client.listVersions("workgraph", "pr-quality");
  });

  it("404 throws VersionNotFoundError", async () => {
    const fetchImpl = mockFetch(async () => new Response("", { status: 404 }));
    const client = new HttpRegistryClient({ baseUrl, fetchImpl });
    await expect(
      client.getVersion("x", "y", "0.0.0")
    ).rejects.toBeInstanceOf(VersionNotFoundError);
  });

  it("401 throws RegistryError with status", async () => {
    const fetchImpl = mockFetch(async () => new Response("", { status: 401 }));
    const client = new HttpRegistryClient({ baseUrl, fetchImpl });
    try {
      await client.getVersion("x", "y", "0.0.0");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryError);
      expect((err as RegistryError).status).toBe(401);
    }
  });

  it("fetchAtomFile sha mismatch → IntegrityError", async () => {
    const bytes = Buffer.from("oops");
    const fetchImpl = mockFetch(
      async () => new Response(bytes, { status: 200 })
    );
    const client = new HttpRegistryClient({ baseUrl, fetchImpl });
    await expect(
      client.fetchAtomFile(
        "workgraph",
        "pr-quality",
        "0.1.0",
        "skill",
        "SKILL.md",
        "0".repeat(64)
      )
    ).rejects.toBeInstanceOf(IntegrityError);
  });

  it("fetchManifest returns text body", async () => {
    const fetchImpl = mockFetch(
      async () =>
        new Response("agentpack: '1.0'\nmetadata:\n  id: x.y\n", { status: 200 })
    );
    const client = new HttpRegistryClient({ baseUrl, fetchImpl });
    expect(await client.fetchManifest("x", "y", "0.1.0")).toContain("agentpack");
  });

  it("getVersion 200 returns parsed shape", async () => {
    const fetchImpl = mockFetch(
      async () => new Response(JSON.stringify(sampleVersion), { status: 200 })
    );
    const client = new HttpRegistryClient({ baseUrl, fetchImpl });
    expect(await client.getVersion("x", "y", "0.1.0")).toEqual(sampleVersion);
  });
});
