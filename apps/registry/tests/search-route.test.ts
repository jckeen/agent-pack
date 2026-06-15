/**
 * Route-handler tests for the public full-text search route.
 *
 *   GET /api/search?q=...
 *
 * Unauthenticated, so the only gate is the per-IP rate limiter. We mock the DB
 * boundary (`@/lib/db`) and keep the real rate limiter (it's an in-process Map
 * keyed by IP — each test uses a distinct X-Forwarded-For so windows don't
 * collide). Assertions cover: empty-query short-circuit, DB-unconfigured
 * graceful empty result, FTS row mapping, and the 429 after the per-IP budget
 * is exhausted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const _db: { configured: boolean; rows: unknown[] } = { configured: true, rows: [] };

function makeChain(result: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "innerJoin", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  chain.then = (
    onFulfilled: (v: unknown[]) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

vi.mock("@/lib/db", () => ({
  getDb: () => (_db.configured ? { select: () => makeChain(_db.rows) } : null),
  packs: {
    slug: "slug",
    description: "description",
    tags: "tags",
    search: "search",
    publisherId: "publisher_id",
    id: "id",
  },
  publishers: { slug: "slug", id: "id" },
}));

import { GET as search } from "@/app/api/search/route";

let ipCounter = 0;

/** Each request gets a fresh IP so the in-process rate-limit window is clean. */
function searchReq(q: string | null, ip?: string): Request {
  const u = new URL("https://registry.example.com/api/search");
  if (q !== null) u.searchParams.set("q", q);
  const headers: Record<string, string> = {};
  headers["x-forwarded-for"] = ip ?? `10.0.0.${++ipCounter}`;
  return new Request(u, { headers });
}

beforeEach(() => {
  _db.configured = true;
  _db.rows = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/search", () => {
  it("returns an empty result set for a blank query without hitting the DB", async () => {
    const res = await search(searchReq("   "));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  });

  it("returns an empty result set when the DB is unconfigured", async () => {
    _db.configured = false;
    const res = await search(searchReq("anything"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  });

  it("maps FTS rows into the public result shape", async () => {
    _db.rows = [
      {
        publisher: "acme",
        pack: "mypack",
        description: "a pack",
        tags: ["ci"],
        rank: 0.42,
      },
    ];
    const res = await search(searchReq("pack"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results).toHaveLength(1);
    expect(json.results[0]).toMatchObject({
      publisher: "acme",
      pack: "mypack",
      description: "a pack",
      tags: ["ci"],
      latestVersion: null,
      rank: 0.42,
    });
  });

  it("defaults tags to [] when a row has none", async () => {
    _db.rows = [{ publisher: "acme", pack: "p", description: "d", tags: null, rank: 1 }];
    const res = await search(searchReq("p"));
    const json = await res.json();
    expect(json.results[0].tags).toEqual([]);
  });

  it("429s once the per-IP rate-limit budget is exhausted", async () => {
    const ip = "203.0.113.99";
    // The limiter allows 30 hits / 60s per IP. The 31st must be throttled.
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) {
      last = await search(searchReq("p", ip));
    }
    expect(last?.status).toBe(429);
  });
});
