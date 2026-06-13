/**
 * Token generation primitives and verifyBearer TTL-cache behaviour.
 *
 * verifyBearer requires a live DB for its happy path; that integration is
 * exercised via smoke-e2e.sh once DATABASE_URL is provisioned. Here we:
 *  - test pure helpers (generateToken, hashToken, findUngrantableScope, requireScope)
 *  - test the TTL cache mechanics by injecting a mock DB so we can assert cache
 *    hits (no second DB call), cache expiry (re-query after TTL), and the
 *    revoked-token staleness window (bounded by VERIFY_BEARER_TTL_MS).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetBearerCacheForTests,
  findUngrantableScope,
  generateToken,
  hashToken,
  requireScope,
  VERIFY_BEARER_TTL_MS,
  type VerifiedToken,
} from "@/lib/tokens";

describe("generateToken", () => {
  it("produces a agp_live_ prefixed 41-char token", () => {
    const { token } = generateToken();
    expect(token.startsWith("agp_live_")).toBe(true);
    expect(token.length).toBe(41);
  });

  it("prefix is the first 12 chars", () => {
    const { token, prefix } = generateToken();
    expect(prefix).toBe(token.slice(0, 12));
    expect(prefix.length).toBe(12);
  });

  it("sha256 is lowercase hex, 64 chars", () => {
    const { sha256 } = generateToken();
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("each call yields a fresh token", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.token).not.toBe(b.token);
    expect(a.sha256).not.toBe(b.sha256);
  });
});

describe("hashToken", () => {
  it("is stable for the same input", () => {
    const t = "agp_live_" + "a".repeat(32);
    expect(hashToken(t)).toBe(hashToken(t));
  });

  it("returns 64 lowercase hex chars", () => {
    const t = "agp_live_" + "b".repeat(32);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("findUngrantableScope (creation-time entitlement gate)", () => {
  it("refuses to mint admin:registry for anyone, even a publisher member", () => {
    expect(findUngrantableScope(["admin:registry"], ["acme"])).toEqual({
      scope: "admin:registry",
      reason: "admin_scope_not_self_grantable",
    });
  });

  it("refuses a publish scope for a publisher the user is not a member of", () => {
    expect(findUngrantableScope(["publish:packs@trusted"], ["acme"])).toEqual({
      scope: "publish:packs@trusted",
      reason: "not_publisher_member",
    });
  });

  it("refuses read:private for a non-member publisher", () => {
    expect(findUngrantableScope(["read:private@trusted"], [])).toEqual({
      scope: "read:private@trusted",
      reason: "not_publisher_member",
    });
  });

  it("allows a scoped publish for a publisher the user belongs to", () => {
    expect(findUngrantableScope(["publish:packs@acme"], ["acme", "other"])).toBeNull();
  });

  it("allows plain (unscoped) grants — they are gated at use time by membership", () => {
    expect(findUngrantableScope(["read:packs", "publish:packs"], [])).toBeNull();
  });

  it("returns the first offending scope in a mixed list", () => {
    expect(
      findUngrantableScope(["read:packs", "admin:registry", "publish:packs@x"], []),
    ).toEqual({ scope: "admin:registry", reason: "admin_scope_not_self_grantable" });
  });
});

describe("requireScope (use-time defense-in-depth)", () => {
  const mk = (scopes: string[], publisherSlugs: string[]): VerifiedToken => ({
    userId: "u1",
    tokenId: "t1",
    publisherIds: [],
    publisherSlugs,
    scopes,
  });

  it("admin:registry is a super-scope", () => {
    expect(() =>
      requireScope(mk(["admin:registry"], []), "publish:packs", "acme"),
    ).not.toThrow();
  });

  it("a scoped token only works for a publisher the user still belongs to", () => {
    // Token carries publish:packs@acme but the user is no longer a member of acme.
    expect(() =>
      requireScope(mk(["publish:packs@acme"], []), "publish:packs", "acme"),
    ).toThrow();
  });

  it("a scoped token works when membership is intact", () => {
    expect(() =>
      requireScope(mk(["publish:packs@acme"], ["acme"]), "publish:packs", "acme"),
    ).not.toThrow();
  });

  it("plain publish scope requires membership in the target publisher", () => {
    expect(() =>
      requireScope(mk(["publish:packs"], []), "publish:packs", "acme"),
    ).toThrow();
    expect(() =>
      requireScope(mk(["publish:packs"], ["acme"]), "publish:packs", "acme"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifyBearer TTL cache
//
// vi.mock is hoisted above all imports, so the factory cannot close over
// variables declared inside a describe() block. We use a module-level
// mutable state object (_mockDb) that the hoisted factory captures by
// reference. Each test mutates _mockDb.selectCalls / _mockDb.tokenExists
// and the factory's closure sees the live values.
//
// What we CAN test here (no live PG):
//   - cache hit returns the same principal without issuing a second DB call
//   - cache expiry causes a re-query after the TTL window passes
//   - a null (invalid-token) result is also cached (no re-query on repeated probes)
//   - VERIFY_BEARER_TTL_MS exported constant bounds the staleness window
//
// What we CANNOT test here:
//   - actual Postgres connectivity
//   - last_used_at fire-and-forget (fire-and-forget is void, no observable effect)
//   - publisher membership resolution against live rows
//   - concurrent invalidation across serverless instances (each has its own Map)
// ---------------------------------------------------------------------------

// Module-level mock state — must be declared before vi.mock() factory usage.
// vi.mock is hoisted; variables defined here are in scope for the factory.
const _mockDb = {
  selectCalls: 0,
  tokenExists: true,
  fakeRow: {
    id: "tok-uuid-1",
    userId: "user-uuid-1",
    tokenSha256: "", // filled in after hashToken is callable
    revokedAt: null,
    scopes: ["publish:packs"],
    tokenPrefix: "agp_live_ccc",
    name: "ci",
    publisherId: null,
    lastUsedAt: null,
    createdAt: new Date(),
  },
};

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => {
      _mockDb.selectCalls++;
      const rows = _mockDb.tokenExists ? [_mockDb.fakeRow] : [];
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(rows),
          }),
          innerJoin: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
      };
    },
    update: () => ({
      set: () => ({
        where: () => ({ catch: () => Promise.resolve() }),
      }),
    }),
  }),
  // Drizzle table objects used in where() calls — stubs are enough because
  // the mock DB ignores them; the real drizzle operators are not called.
  apiTokens: { tokenSha256: "token_sha256", revokedAt: "revoked_at", id: "id" },
  publisherMembers: { userId: "user_id", publisherId: "publisher_id" },
  publishers: { id: "id", slug: "slug" },
}));

const CACHE_FAKE_TOKEN = "agp_live_" + "c".repeat(32);

describe("verifyBearer TTL cache", () => {
  beforeEach(() => {
    _mockDb.selectCalls = 0;
    _mockDb.tokenExists = true;
    _mockDb.fakeRow.tokenSha256 = hashToken(CACHE_FAKE_TOKEN);
    __resetBearerCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeAuthReq(token: string): Request {
    return new Request("https://registry.example.com/api/packs", {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("VERIFY_BEARER_TTL_MS is exported and is 45 s", () => {
    expect(VERIFY_BEARER_TTL_MS).toBe(45_000);
  });

  it("cache hit: second call returns the same principal without additional DB SELECTs", async () => {
    const { verifyBearer } = await import("@/lib/tokens");

    // Cold call: issues 2 SELECTs — one for the token row, one for publisher memberships.
    const p1 = await verifyBearer(makeAuthReq(CACHE_FAKE_TOKEN));
    const afterFirstCall = _mockDb.selectCalls; // should be 2

    // Cache hit: no DB calls at all.
    const p2 = await verifyBearer(makeAuthReq(CACHE_FAKE_TOKEN));
    const afterSecondCall = _mockDb.selectCalls;

    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    // Second call must not have issued any additional selects.
    expect(afterSecondCall).toBe(afterFirstCall);
    expect(p1?.userId).toBe(p2?.userId);
    expect(p1?.tokenId).toBe(p2?.tokenId);
  });

  it("cache miss after TTL expiry: re-queries the DB", async () => {
    vi.useFakeTimers();
    const { verifyBearer } = await import("@/lib/tokens");

    // Cold call: 2 SELECTs (token + memberships).
    await verifyBearer(makeAuthReq(CACHE_FAKE_TOKEN));
    const afterFirstCall = _mockDb.selectCalls;

    // Warm call within TTL: no additional SELECTs.
    await verifyBearer(makeAuthReq(CACHE_FAKE_TOKEN));
    expect(_mockDb.selectCalls).toBe(afterFirstCall);

    // Advance time past the TTL — next call should be a cache miss.
    vi.advanceTimersByTime(VERIFY_BEARER_TTL_MS + 1);

    await verifyBearer(makeAuthReq(CACHE_FAKE_TOKEN));
    // Should have issued another 2 SELECTs (token + memberships again).
    expect(_mockDb.selectCalls).toBe(afterFirstCall + afterFirstCall);
  });

  it("null result (invalid token) is cached — repeated probes issue only one DB SELECT", async () => {
    _mockDb.tokenExists = false;
    const { verifyBearer } = await import("@/lib/tokens");

    const r1 = await verifyBearer(makeAuthReq(CACHE_FAKE_TOKEN));
    // Only 1 SELECT (token lookup; no membership query since row is null).
    const afterFirstCall = _mockDb.selectCalls;

    const r2 = await verifyBearer(makeAuthReq(CACHE_FAKE_TOKEN));

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    // Second call was served from cache — no additional selects.
    expect(_mockDb.selectCalls).toBe(afterFirstCall);
  });

  it("revoked-token staleness is bounded by VERIFY_BEARER_TTL_MS", async () => {
    vi.useFakeTimers();
    const { verifyBearer } = await import("@/lib/tokens");

    // First call: token is valid — principal cached.
    const before = await verifyBearer(makeAuthReq(CACHE_FAKE_TOKEN));
    expect(before).not.toBeNull();

    // Simulate revocation: DB would now return no row for this token.
    _mockDb.tokenExists = false;

    // Within TTL: stale principal still returned from cache (expected behaviour
    // — documented staleness window of up to VERIFY_BEARER_TTL_MS).
    const duringTTL = await verifyBearer(makeAuthReq(CACHE_FAKE_TOKEN));
    expect(duringTTL).not.toBeNull(); // stale cache hit — intentional

    // After TTL expires: cache is cold, DB returns no row → null.
    vi.advanceTimersByTime(VERIFY_BEARER_TTL_MS + 1);
    const afterTTL = await verifyBearer(makeAuthReq(CACHE_FAKE_TOKEN));
    expect(afterTTL).toBeNull();
  });
});
