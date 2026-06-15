/**
 * Route-handler tests for the token management API.
 *
 *   POST /api/tokens          — mint a token
 *   GET  /api/tokens          — list the caller's live tokens
 *   DELETE /api/tokens/[id]   — revoke a token (owner-scoped)
 *
 * These handlers gate on a NextAuth *session* (auth()), not on a Bearer token,
 * so we mock `@/lib/auth`'s `auth()` and `@/lib/db`'s `getDb()` at the module
 * boundary — exactly the boundary the route reaches across. We assert the real
 * behaviour: the 401 gate firing without a session, the entitlement gate
 * (findUngrantableScope) refusing admin/cross-publisher scopes with 403, the
 * masked-token mint contract (full token returned once + a short prefix), and
 * the owner-scoped revoke returning 404 when the (id, userId) update matches
 * no row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock state captured by the hoisted vi.mock factories (vi.mock is hoisted
// above imports, so the factories must close over module-level mutables).
// ---------------------------------------------------------------------------
const _session: { value: unknown } = { value: null };

/**
 * A scripted fake Drizzle client. Each entry-point call (select/insert/update)
 * shifts the next canned result off `_db.queue`. The chain methods are no-ops
 * that return the same thenable so any call order resolves to that result.
 */
const _db: { configured: boolean; queue: unknown[][] } = {
  configured: true,
  queue: [],
};

function makeChain(result: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "values", "returning", "set"]) {
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
  };
}

vi.mock("@/lib/auth", () => ({
  auth: async () => _session.value,
}));

vi.mock("@/lib/db", () => ({
  getDb: () => (_db.configured ? fakeDb() : null),
  apiTokens: {
    id: "id",
    userId: "user_id",
    name: "name",
    tokenPrefix: "token_prefix",
    scopes: "scopes",
    lastUsedAt: "last_used_at",
    createdAt: "created_at",
    revokedAt: "revoked_at",
  },
  publishers: { id: "id", slug: "slug" },
}));

// Imported after the mocks are registered.
import { GET as listTokens, POST as mintToken } from "@/app/api/tokens/route";
import { DELETE as revokeToken } from "@/app/api/tokens/[id]/route";

function makePostReq(body: unknown): Request {
  return new Request("https://registry.example.com/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const SESSION_WITH = (publisherSlugs: string[] = []) => ({
  user: { id: "user-1" },
  publisherSlugs,
});

beforeEach(() => {
  _session.value = null;
  _db.configured = true;
  _db.queue = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/tokens (mint)", () => {
  it("401s without a session (the auth gate fires before anything else)", async () => {
    _session.value = null;
    const res = await mintToken(makePostReq({ name: "ci", scopes: ["read:packs"] }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("503s when the DB is unconfigured", async () => {
    _session.value = SESSION_WITH();
    _db.configured = false;
    const res = await mintToken(makePostReq({ name: "ci", scopes: ["read:packs"] }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "db_unconfigured" });
  });

  it("422s on invalid JSON body", async () => {
    _session.value = SESSION_WITH();
    const res = await mintToken(makePostReq("{not json"));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("validation");
  });

  it("422s when the schema rejects the body (empty scopes)", async () => {
    _session.value = SESSION_WITH();
    const res = await mintToken(makePostReq({ name: "ci", scopes: [] }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("validation");
  });

  it("403s when minting admin:registry — never self-grantable (CWE-862)", async () => {
    _session.value = SESSION_WITH(["acme"]);
    const res = await mintToken(makePostReq({ name: "x", scopes: ["admin:registry"] }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("forbidden");
    expect(json.reason).toBe("admin_scope_not_self_grantable");
    expect(json.scope).toBe("admin:registry");
  });

  it("403s when minting a publisher-scoped grant the user is not a member of", async () => {
    _session.value = SESSION_WITH(["acme"]);
    const res = await mintToken(
      makePostReq({ name: "x", scopes: ["publish:packs@trusted"] }),
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("forbidden");
    expect(json.reason).toBe("not_publisher_member");
  });

  it("mints a token and returns the full token once plus a 12-char prefix", async () => {
    _session.value = SESSION_WITH(["acme"]);
    // The insert().returning() resolves to the new row id.
    _db.queue = [[{ id: "tok-uuid-1" }]];
    const res = await mintToken(
      makePostReq({ name: "ci", scopes: ["publish:packs@acme"] }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe("tok-uuid-1");
    expect(json.token).toMatch(/^agp_live_[0-9a-f]{32}$/);
    expect(json.token).toHaveLength(41);
    // The displayed prefix is the masked form — first 12 chars only.
    expect(json.prefix).toBe(json.token.slice(0, 12));
    expect(json.prefix).toHaveLength(12);
    expect(json.scopes).toEqual(["publish:packs@acme"]);
  });

  it("422s when publisherSlug names an unknown publisher", async () => {
    _session.value = SESSION_WITH(["acme"]);
    // publisher lookup resolves to no row.
    _db.queue = [[]];
    const res = await mintToken(
      makePostReq({ name: "ci", scopes: ["read:packs"], publisherSlug: "ghost" }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("validation");
  });

  it("403s when publisherSlug exists but the user is not a member of it", async () => {
    _session.value = SESSION_WITH(["acme"]); // not a member of "other"
    // publisher lookup resolves to a row.
    _db.queue = [[{ id: "pub-other" }]];
    const res = await mintToken(
      makePostReq({ name: "ci", scopes: ["read:packs"], publisherSlug: "other" }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("not_publisher_member");
  });
});

describe("GET /api/tokens (list)", () => {
  it("401s without a session", async () => {
    _session.value = null;
    const res = await listTokens();
    expect(res.status).toBe(401);
  });

  it("503s when the DB is unconfigured", async () => {
    _session.value = SESSION_WITH();
    _db.configured = false;
    const res = await listTokens();
    expect(res.status).toBe(503);
  });

  it("returns the caller's live tokens", async () => {
    _session.value = SESSION_WITH();
    _db.queue = [
      [
        {
          id: "t1",
          name: "ci",
          prefix: "agp_live_abc",
          scopes: ["read:packs"],
          last_used_at: null,
          created_at: new Date("2026-01-01").toISOString(),
          revoked_at: null,
        },
      ],
    ];
    const res = await listTokens();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tokens).toHaveLength(1);
    expect(json.tokens[0].id).toBe("t1");
  });
});

describe("DELETE /api/tokens/[id] (revoke)", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("401s without a session", async () => {
    _session.value = null;
    const res = await revokeToken(new Request("https://x/api/tokens/t1"), ctx("t1"));
    expect(res.status).toBe(401);
  });

  it("503s when the DB is unconfigured", async () => {
    _session.value = SESSION_WITH();
    _db.configured = false;
    const res = await revokeToken(new Request("https://x/api/tokens/t1"), ctx("t1"));
    expect(res.status).toBe(503);
  });

  it("204s and revokes when the owner-scoped update matches a row", async () => {
    _session.value = SESSION_WITH();
    // update().returning() resolves to the revoked row id.
    _db.queue = [[{ id: "t1" }]];
    const res = await revokeToken(new Request("https://x/api/tokens/t1"), ctx("t1"));
    expect(res.status).toBe(204);
  });

  it("404s when no (id, userId)-matching row exists — cannot revoke another user's token", async () => {
    _session.value = SESSION_WITH();
    // Owner-scoped update matches nothing (wrong owner or unknown id).
    _db.queue = [[]];
    const res = await revokeToken(
      new Request("https://x/api/tokens/someone-elses"),
      ctx("someone-elses"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
  });
});
