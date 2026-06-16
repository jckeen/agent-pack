/**
 * Route-handler tests for the publish auth + integrity gates — the most
 * security-critical surface in the registry.
 *
 *   POST /api/publish/init                  — reserve a version, presign R2 PUTs
 *   POST /api/publish/[publishId]/finalize  — verify uploads, commit the version
 *
 * Boundaries mocked: `@/lib/tokens` (verifyBearer — the Bearer auth gate;
 * requireScope is kept REAL via importActual so the scope check fires
 * authentically), `@/lib/db` (Postgres), `@/lib/r2` (presign + HEAD), and
 * `@/lib/rate-limit` (kept real but reset, since it's an in-process Map).
 *
 * We assert the real gates, not echoed input:
 *   - 401 when verifyBearer returns null (no/invalid Bearer)
 *   - 403 when the token holds no publish scope on the target publisher
 *   - 409 when the version already exists (init) / publish already finalized
 *   - 410 when the pending publish has expired
 *   - 422 when an uploaded object's size disagrees with the declared bytes
 *   - 403 finalize-hijack guard: a different user cannot finalize a publish
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mutable state captured by hoisted vi.mock factories.
// ---------------------------------------------------------------------------
interface VerifiedToken {
  userId: string;
  tokenId: string;
  publisherIds: string[];
  publisherSlugs: string[];
  scopes: string[];
}

const _auth: { verified: VerifiedToken | null } = { verified: null };

const _db: {
  configured: boolean;
  queue: unknown[][];
  transactionResult: unknown;
  transactionThrows: unknown;
} = {
  configured: true,
  queue: [],
  transactionResult: null,
  transactionThrows: null,
};

const _r2: {
  presign: { url: string; headers: Record<string, string> };
  presignThrows: Error | null;
  head: Record<string, { contentLength: number; etag: string } | null>;
  headThrows: Error | null;
} = {
  presign: { url: "https://r2.example/put", headers: { "content-length": "1" } },
  presignThrows: null,
  head: {},
  headThrows: null,
};

function makeChain(result: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of [
    "from",
    "where",
    "limit",
    "values",
    "returning",
    "set",
    "innerJoin",
    "orderBy",
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
    transaction: async () => {
      if (_db.transactionThrows) throw _db.transactionThrows;
      return _db.transactionResult;
    },
  };
}

vi.mock("@/lib/tokens", async () => {
  // Keep requireScope REAL so the scope gate fires authentically (it throws a
  // Response on mismatch, which the route catches). Only verifyBearer is faked.
  const actual = await vi.importActual<typeof import("@/lib/tokens")>("@/lib/tokens");
  return {
    ...actual,
    verifyBearer: async () => _auth.verified,
  };
});

vi.mock("@/lib/db", () => ({
  getDb: () => (_db.configured ? fakeDb() : null),
  // Drizzle table stubs — the fake db ignores the operators built from them.
  publishers: { id: "id", slug: "slug" },
  packs: { id: "id", publisherId: "publisher_id", slug: "slug" },
  packVersions: { id: "id", packId: "pack_id", version: "version" },
  packFiles: {},
  packSignatures: {},
  atoms: {},
  compatibilities: {},
  publishes: { id: "id" },
}));

vi.mock("@/lib/r2", () => {
  class R2NotConfiguredError extends Error {
    constructor() {
      super("R2 not configured");
      this.name = "R2NotConfiguredError";
    }
  }
  return {
    R2NotConfiguredError,
    presignPutUrl: async () => {
      if (_r2.presignThrows) throw _r2.presignThrows;
      return _r2.presign;
    },
    headObject: async (key: string) => {
      if (_r2.headThrows) throw _r2.headThrows;
      return key in _r2.head ? _r2.head[key] : { contentLength: 1, etag: "e" };
    },
  };
});

// Imported after mocks.
import { POST as publishInit } from "@/app/api/publish/init/route";
import { POST as publishFinalize } from "@/app/api/publish/[publishId]/finalize/route";

const SHA = "a".repeat(64);

function bearerReq(url: string, body?: unknown, withAuth = true): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (withAuth) headers.authorization = "Bearer agp_live_test";
  return new Request(url, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function validInitBody(overrides: Record<string, unknown> = {}) {
  return {
    publisher: "acme",
    pack: "mypack",
    version: "1.0.0",
    manifestSha256: SHA,
    manifestBytes: 100,
    files: [{ path: "atoms/a.md", sha256: SHA, bytes: 50, atomId: "a" }],
    metadata: { name: "My Pack", description: "desc", tags: [], compatibilities: [] },
    ...overrides,
  };
}

const TOKEN = (scopes: string[], slugs: string[], userId = "user-1"): VerifiedToken => ({
  userId,
  tokenId: "tok-1",
  publisherIds: [],
  publisherSlugs: slugs,
  scopes,
});

beforeEach(() => {
  _auth.verified = null;
  _db.configured = true;
  _db.queue = [];
  _db.transactionResult = null;
  _db.transactionThrows = null;
  _r2.presign = { url: "https://r2.example/put", headers: { "content-length": "1" } };
  _r2.presignThrows = null;
  _r2.head = {};
  _r2.headThrows = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// publish/init
// ===========================================================================
describe("POST /api/publish/init — auth + conflict gates", () => {
  it("401s when no Bearer token resolves (verifyBearer returns null)", async () => {
    _auth.verified = null;
    const res = await publishInit(
      bearerReq("https://x/api/publish/init", validInitBody(), false),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized");
  });

  it("400s on invalid JSON", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    const req = new Request("https://x/api/publish/init", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: "{broken",
    });
    const res = await publishInit(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_json");
  });

  it("422s when the init body fails schema validation", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    const res = await publishInit(
      bearerReq("https://x/api/publish/init", validInitBody({ version: "not-semver" })),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("validation");
  });

  it("403s when the token holds no publish scope on the target publisher", async () => {
    // Has publish:packs but is not a member of acme → requireScope throws 403.
    _auth.verified = TOKEN(["publish:packs"], []);
    const res = await publishInit(bearerReq("https://x/api/publish/init", validInitBody()));
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("scope_mismatch");
  });

  it("409s when the version already exists for this pack", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    // publisher lookup → pack lookup → version lookup (exists).
    _db.queue = [
      [{ id: "pub-1" }],
      [{ id: "pack-1" }],
      [{ id: "ver-1", publishedAt: new Date("2026-01-01") }],
    ];
    const res = await publishInit(bearerReq("https://x/api/publish/init", validInitBody()));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("version_exists");
  });

  it("503s when R2 presign reports it is unconfigured", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    // publisher row absent → skip conflict check, go straight to presign.
    _db.queue = [[]];
    const { R2NotConfiguredError } = await import("@/lib/r2");
    _r2.presignThrows = new R2NotConfiguredError();
    const res = await publishInit(bearerReq("https://x/api/publish/init", validInitBody()));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("r2_unconfigured");
  });

  it("returns presigned uploads + a publishId on the happy path", async () => {
    _auth.verified = TOKEN(["publish:packs@acme"], ["acme"]);
    // publisher absent (no conflict), then publishes insert().returning().
    _db.queue = [[], [{ id: "pub-uuid-xyz" }]];
    const res = await publishInit(bearerReq("https://x/api/publish/init", validInitBody()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.publishId).toBe("pub-uuid-xyz");
    // manifest + 1 file = 2 presigned uploads.
    expect(json.presignedUploads).toHaveLength(2);
    expect(json.presignedUploads[0].url).toBe("https://r2.example/put");
    expect(typeof json.expiresAt).toBe("string");
  });
});

// ===========================================================================
// publish/finalize
// ===========================================================================
describe("POST /api/publish/[publishId]/finalize — integrity + ownership gates", () => {
  const ctx = (publishId: string) => ({ params: Promise.resolve({ publishId }) });

  const pendingPublish = (over: Record<string, unknown> = {}) => ({
    id: "pub-1",
    publisherSlug: "acme",
    packSlug: "mypack",
    version: "1.0.0",
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
    createdBy: "user-1",
    presignedFiles: [
      {
        path: "AGENTPACK.yaml",
        r2Key: "acme/mypack/1.0.0/AGENTPACK.yaml",
        sha256: SHA,
        bytes: 100,
      },
      {
        path: "atoms/a.md",
        r2Key: "acme/mypack/1.0.0/atoms/a.md",
        sha256: SHA,
        bytes: 50,
        atomId: "a",
      },
    ],
    ...over,
  });

  it("401s when no Bearer token resolves", async () => {
    _auth.verified = null;
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize", undefined, false),
      ctx("pub-1"),
    );
    expect(res.status).toBe(401);
  });

  it("404s when the publishId is unknown", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    _db.queue = [[]]; // publishes lookup empty
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/ghost/finalize"),
      ctx("ghost"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });

  it("403s (hijack guard) when a different user tries to finalize someone's publish", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"], "attacker");
    _db.queue = [[pendingPublish({ createdBy: "victim" })]];
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize"),
      ctx("pub-1"),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
  });

  it("403s when the initiating user lacks publish scope on the publisher", async () => {
    // Same user who created it, but no membership in acme → requireScope throws.
    _auth.verified = TOKEN(["publish:packs"], [], "user-1");
    _db.queue = [[pendingPublish()]];
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize"),
      ctx("pub-1"),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("scope_mismatch");
  });

  it("409s when the publish is no longer pending (already finalized)", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    _db.queue = [[pendingPublish({ status: "completed" })]];
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize"),
      ctx("pub-1"),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_finalized");
  });

  it("410s when the pending publish has expired", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    _db.queue = [[pendingPublish({ expiresAt: new Date(Date.now() - 1000) })]];
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize"),
      ctx("pub-1"),
    );
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("publish_expired");
  });

  it("422s when an uploaded object's size disagrees with the declared bytes", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    _db.queue = [[pendingPublish()]];
    // HEAD returns a wrong size for the manifest key → size_mismatch.
    _r2.head = {
      "acme/mypack/1.0.0/AGENTPACK.yaml": { contentLength: 999, etag: "e" },
      "acme/mypack/1.0.0/atoms/a.md": { contentLength: 50, etag: "e" },
    };
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize"),
      ctx("pub-1"),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("size_mismatch");
    expect(json.mismatched[0].path).toBe("AGENTPACK.yaml");
    expect(json.mismatched[0].expected).toBe(100);
    expect(json.mismatched[0].got).toBe(999);
  });

  it("422s when an uploaded object is missing from R2", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    _db.queue = [[pendingPublish()]];
    _r2.head = {
      "acme/mypack/1.0.0/AGENTPACK.yaml": null, // HEAD 404 → missing
      "acme/mypack/1.0.0/atoms/a.md": { contentLength: 50, etag: "e" },
    };
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize"),
      ctx("pub-1"),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("size_mismatch");
    expect(json.mismatched[0].got).toBe("missing");
  });

  it("404s when the publisher row no longer exists at commit time", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    // publishes lookup, then publishers lookup (empty). Sizes all match.
    _r2.head = {
      "acme/mypack/1.0.0/AGENTPACK.yaml": { contentLength: 100, etag: "e" },
      "acme/mypack/1.0.0/atoms/a.md": { contentLength: 50, etag: "e" },
    };
    _db.queue = [[pendingPublish()], []];
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize"),
      ctx("pub-1"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("publisher_not_found");
  });

  it("commits the version and returns packId/versionId/url on the happy path", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    // publishes lookup, publishers lookup (exists). The transaction returns ids.
    _r2.head = {
      "acme/mypack/1.0.0/AGENTPACK.yaml": { contentLength: 100, etag: "e" },
      "acme/mypack/1.0.0/atoms/a.md": { contentLength: 50, etag: "e" },
    };
    _db.queue = [[pendingPublish()], [{ id: "pub-uuid" }]];
    _db.transactionResult = { packId: "pack-1", versionId: "ver-1" };
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize"),
      ctx("pub-1"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.packId).toBe("pack-1");
    expect(json.versionId).toBe("ver-1");
    expect(json.url).toContain("/packs/acme/mypack/1.0.0");
  });

  it("409s when a concurrent publish won the version race (unique violation → version_exists)", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    _r2.head = {
      "acme/mypack/1.0.0/AGENTPACK.yaml": { contentLength: 100, etag: "e" },
      "acme/mypack/1.0.0/atoms/a.md": { contentLength: 50, etag: "e" },
    };
    _db.queue = [[pendingPublish()], [{ id: "pub-uuid" }]];
    // The finalize transaction is the real serialization point — a Postgres
    // unique-violation on pack_versions_pack_version_uq must surface as 409,
    // not a generic 500, so the CLI stops retrying. (backend-architect H1)
    _db.transactionThrows = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize"),
      ctx("pub-1"),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("version_exists");
  });

  it("500s with finalize_failed on a non-unique-violation transaction error", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    _r2.head = {
      "acme/mypack/1.0.0/AGENTPACK.yaml": { contentLength: 100, etag: "e" },
      "acme/mypack/1.0.0/atoms/a.md": { contentLength: 50, etag: "e" },
    };
    _db.queue = [[pendingPublish()], [{ id: "pub-uuid" }]];
    _db.transactionThrows = new Error("connection reset");
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize"),
      ctx("pub-1"),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("finalize_failed");
  });

  it("422s when a malformed signature envelope is supplied (rejects before persistence)", async () => {
    _auth.verified = TOKEN(["publish:packs"], ["acme"]);
    _db.queue = [[pendingPublish()]];
    // A body carrying a `signature` that fails signedManifestSchema.safeParse.
    // This is the integrity gate: a bogus signature aborts the publish *before*
    // any version row is written.
    const res = await publishFinalize(
      bearerReq("https://x/api/publish/pub-1/finalize", {
        signature: { not: "a valid signed manifest" },
      }),
      ctx("pub-1"),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_signature_envelope");
  });
});
