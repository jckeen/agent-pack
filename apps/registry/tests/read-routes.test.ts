/**
 * Route-handler tests for the public/read API surface that Issue #25 left
 * uncovered:
 *
 *   GET /api/me                                        — Bearer-gated identity
 *   GET /api/v1/health                                 — db + r2 probe
 *   GET /api/packs                                      — paginated list + real total
 *   GET /api/packs/[publisher]/[pack]                   — detail + semver latest
 *   GET /api/v1/packs/.../versions/[version]/signatures — signature list
 *   GET/POST /api/packs/[publisher]/[pack]/reviews      — placeholder contract
 *
 * Boundaries mocked at the module edge: `@/lib/tokens` (verifyBearer),
 * `@/lib/db` (scripted fake Drizzle client), `@/lib/r2` (r2Client). The fake db
 * shifts a canned result per entry-point call, so each test scripts results in
 * call order. `compareSemver` is the REAL comparator from `@agentpack/db`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const _auth: { verified: { userId: string } | null } = { verified: null };

const _db: {
  configured: boolean;
  queue: unknown[][];
  execThrows: boolean;
} = { configured: true, queue: [], execThrows: false };

const _r2: { throws: boolean } = { throws: false };

function makeChain(result: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from",
    "where",
    "innerJoin",
    "orderBy",
    "limit",
    "offset",
    "values",
    "returning",
    "set",
  ]) {
    chain[m] = () => chain;
  }
  chain.then = (
    onFulfilled: (v: unknown[]) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

function fakeDb(): Record<string, unknown> {
  const next = (): Record<string, unknown> => makeChain(_db.queue.shift() ?? []);
  return {
    select: () => next(),
    insert: () => next(),
    update: () => next(),
    execute: async () => {
      if (_db.execThrows) throw new Error("db down");
      return [{ "?column?": 1 }];
    },
  };
}

vi.mock("@/lib/tokens", () => ({
  verifyBearer: async () => _auth.verified,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => (_db.configured ? fakeDb() : null),
  users: { id: "id", username: "username" },
  publishers: { id: "id", slug: "slug" },
  publisherMembers: { userId: "user_id", publisherId: "publisher_id" },
  packs: {
    id: "id",
    slug: "slug",
    description: "description",
    tags: "tags",
    publisherId: "publisher_id",
    latestVersionId: "latest_version_id",
  },
  packVersions: {
    packId: "pack_id",
    version: "version",
    publishedAt: "published_at",
    status: "status",
  },
  packSignatures: { packVersionId: "pack_version_id", signedAt: "signed_at" },
}));

vi.mock("@/lib/r2", () => ({
  r2Client: () => {
    if (_r2.throws) throw new Error("r2 unconfigured");
    return {};
  },
}));

import { GET as me } from "@/app/api/me/route";
import { GET as health } from "@/app/api/v1/health/route";
import { GET as listPacks } from "@/app/api/packs/route";
import { GET as packDetail } from "@/app/api/packs/[publisher]/[pack]/route";
import { GET as signatures } from "@/app/api/v1/packs/[publisher]/[pack]/versions/[version]/signatures/route";
import {
  GET as reviewsGet,
  POST as reviewsPost,
} from "@/app/api/packs/[publisher]/[pack]/reviews/route";

function getReq(url = "https://registry.example.com/x"): Request {
  return new Request(url);
}

beforeEach(() => {
  _auth.verified = null;
  _db.configured = true;
  _db.queue = [];
  _db.execThrows = false;
  _r2.throws = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/me", () => {
  it("401s without a valid Bearer (verifyBearer returns null)", async () => {
    _auth.verified = null;
    const res = await me(getReq());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("503s when the DB is unconfigured", async () => {
    _auth.verified = { userId: "u1" };
    _db.configured = false;
    const res = await me(getReq());
    expect(res.status).toBe(503);
  });

  it("404s when the verified user id matches no row", async () => {
    _auth.verified = { userId: "ghost" };
    _db.queue = [[]]; // users lookup empty
    const res = await me(getReq());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("user_not_found");
  });

  it("returns identity + publisher memberships", async () => {
    _auth.verified = { userId: "u1" };
    _db.queue = [[{ id: "u1", username: "alice" }], [{ slug: "acme" }, { slug: "beta" }]];
    const res = await me(getReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ id: "u1", username: "alice", publisherSlugs: ["acme", "beta"] });
  });
});

describe("GET /api/v1/health", () => {
  it("200 ok when db and r2 both probe up", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.db).toBe("up");
    expect(json.r2).toBe("up");
    expect(typeof json.version).toBe("string");
  });

  it("503 degraded when the db probe throws", async () => {
    _db.execThrows = true;
    const res = await health();
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe("degraded");
    expect(json.db).toBe("down");
  });

  it("503 degraded with db 'unconfigured' when getDb is null", async () => {
    _db.configured = false;
    const res = await health();
    expect(res.status).toBe(503);
    expect((await res.json()).db).toBe("unconfigured");
  });

  it("503 degraded when r2 is unconfigured", async () => {
    _r2.throws = true;
    const res = await health();
    expect(res.status).toBe(503);
    expect((await res.json()).r2).toBe("unconfigured");
  });
});

describe("GET /api/packs (list)", () => {
  it("returns an empty page when the DB is unconfigured", async () => {
    _db.configured = false;
    const res = await listPacks(getReq("https://x/api/packs"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ packs: [], total: 0 });
  });

  it("maps rows and reports the real total across all packs (not the page size)", async () => {
    _db.queue = [
      [{ publisher: "acme", slug: "p1", description: "d", tags: ["ci"] }],
      [{ value: 57 }], // count() over all packs
    ];
    const res = await listPacks(getReq("https://x/api/packs?limit=1"));
    const json = await res.json();
    expect(json.packs).toHaveLength(1);
    expect(json.packs[0]).toMatchObject({ publisher: "acme", pack: "p1", tags: ["ci"] });
    expect(json.total).toBe(57);
  });

  it("defaults tags to [] when null", async () => {
    _db.queue = [
      [{ publisher: "a", slug: "p", description: "d", tags: null }],
      [{ value: 1 }],
    ];
    const json = await (await listPacks(getReq("https://x/api/packs"))).json();
    expect(json.packs[0].tags).toEqual([]);
  });
});

describe("GET /api/packs/[publisher]/[pack] (detail)", () => {
  const ctx = (publisher: string, pack: string) => ({
    params: Promise.resolve({ publisher, pack }),
  });

  it("404s when the DB is unconfigured", async () => {
    _db.configured = false;
    const res = await packDetail(getReq(), ctx("acme", "p"));
    expect(res.status).toBe(404);
  });

  it("404s when no matching pack row exists", async () => {
    _db.queue = [[]];
    const res = await packDetail(getReq(), ctx("acme", "ghost"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("resolves latestVersion by SEMVER, not lexical order (0.10.0 > 0.9.0)", async () => {
    _db.queue = [
      [{ packId: "pk1", packSlug: "p", description: "d", tags: [], publisherSlug: "acme" }],
      [
        { version: "0.9.0", publishedAt: new Date("2026-01-01"), status: "published" },
        { version: "0.10.0", publishedAt: new Date("2026-02-01"), status: "published" },
        { version: "0.10.1", publishedAt: new Date("2026-03-01"), status: "quarantined" },
      ],
    ];
    const res = await packDetail(getReq(), ctx("acme", "p"));
    expect(res.status).toBe(200);
    const json = await res.json();
    // 0.10.0 must win over 0.9.0 (lexical would pick 0.9.0); the quarantined
    // 0.10.1 must be excluded from "latest".
    expect(json.latestVersion).toBe("0.10.0");
    expect(json.versions).toHaveLength(3);
  });
});

describe("GET /api/v1/packs/.../signatures", () => {
  const ctx = (version: string) => ({
    params: Promise.resolve({ publisher: "acme", pack: "p", version }),
  });

  it("503s when the DB is unconfigured", async () => {
    _db.configured = false;
    const res = await signatures(getReq(), ctx("1.0.0"));
    expect(res.status).toBe(503);
  });

  it("404s publisher_not_found / pack_not_found / version_not_found in order", async () => {
    _db.queue = [[]]; // publisher missing
    expect((await (await signatures(getReq(), ctx("1.0.0"))).json()).error).toBe(
      "publisher_not_found",
    );
    _db.queue = [[{ id: "pub1" }], []]; // pack missing
    expect((await (await signatures(getReq(), ctx("1.0.0"))).json()).error).toBe(
      "pack_not_found",
    );
    _db.queue = [[{ id: "pub1" }], [{ id: "pk1" }], []]; // version missing
    expect((await (await signatures(getReq(), ctx("1.0.0"))).json()).error).toBe(
      "version_not_found",
    );
  });

  it("maps signature rows to the public envelope shape", async () => {
    _db.queue = [
      [{ id: "pub1" }],
      [{ id: "pk1" }],
      [{ id: "ver1", manifestSha256: "m".repeat(64) }],
      [
        {
          bundleB64: "YmFzZTY0",
          manifestSha256: "m".repeat(64),
          envelopeVersion: "1",
          signerSan: "alice@example.com",
          signerIssuer: "https://github.com/login/oauth",
          rekorLogIndex: 42,
          rekorLogId: "rekor-1",
          rekorLogUrl: "https://rekor/42",
          signedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    ];
    const res = await signatures(getReq(), ctx("1.0.0"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.manifestSha256).toBe("m".repeat(64));
    expect(json.signatures).toHaveLength(1);
    expect(json.signatures[0].metadata.identity.san).toBe("alice@example.com");
    expect(json.signatures[0].metadata.rekorLogIndex).toBe(42);
  });
});

describe("/api/packs/[publisher]/[pack]/reviews (placeholder)", () => {
  it("GET returns an empty review list", async () => {
    const res = await reviewsGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reviews: [] });
  });

  it("POST is 501 until user reviews ship", async () => {
    const res = await reviewsPost();
    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe("user_reviews_not_yet_available");
  });
});
