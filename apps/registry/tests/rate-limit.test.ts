import { afterEach, describe, expect, it } from "vitest";

import {
  __resetRateLimit,
  clientKey,
  hit,
  MemoryRateLimitStore,
  type RateLimitStore,
  type RateLimitWindow,
  tooManyRequests,
} from "@/lib/rate-limit";

afterEach(() => __resetRateLimit());

describe("hit (fixed-window rate limiter)", () => {
  it("allows up to `limit` hits then blocks within the window", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      const r = hit("k", 5, 1000, t0);
      expect(r.allowed).toBe(true);
    }
    const blocked = hit("k", 5, 1000, t0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.remaining).toBe(0);
  });

  it("resets after the window elapses", () => {
    const t0 = 2_000_000;
    expect(hit("k", 1, 1000, t0).allowed).toBe(true);
    expect(hit("k", 1, 1000, t0).allowed).toBe(false);
    // After the window, the key is fresh again.
    expect(hit("k", 1, 1000, t0 + 1001).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const t0 = 3_000_000;
    expect(hit("a", 1, 1000, t0).allowed).toBe(true);
    expect(hit("b", 1, 1000, t0).allowed).toBe(true);
    expect(hit("a", 1, 1000, t0).allowed).toBe(false);
  });

  it("reports decreasing remaining", () => {
    const t0 = 4_000_000;
    expect(hit("k", 3, 1000, t0).remaining).toBe(2);
    expect(hit("k", 3, 1000, t0).remaining).toBe(1);
    expect(hit("k", 3, 1000, t0).remaining).toBe(0);
  });
});

describe("pluggable RateLimitStore", () => {
  it("hit() routes through an injected store (adapter seam)", () => {
    // A fake store backed by a plain object so we can assert hit() goes through
    // the interface rather than touching the module-level Map.
    const backing = new Map<string, RateLimitWindow>();
    let gets = 0;
    let sets = 0;
    const fake: RateLimitStore = {
      get(key) {
        gets++;
        return backing.get(key);
      },
      set(key, win) {
        sets++;
        backing.set(key, win);
      },
      delete(key) {
        backing.delete(key);
      },
      clear() {
        backing.clear();
      },
    };

    const t0 = 5_000_000;
    const first = hit("k", 2, 1000, t0, fake);
    expect(first.allowed).toBe(true);
    expect(hit("k", 2, 1000, t0, fake).allowed).toBe(true);
    expect(hit("k", 2, 1000, t0, fake).allowed).toBe(false);

    // The injected store was actually consulted, and the default in-memory
    // store was NOT touched (a fresh default hit starts at full quota).
    expect(gets).toBeGreaterThan(0);
    expect(sets).toBeGreaterThan(0);
    expect(backing.has("k")).toBe(true);
    expect(hit("default-only", 5, 1000, t0).remaining).toBe(4);
  });

  it("MemoryRateLimitStore is the default and is independently usable", () => {
    const store = new MemoryRateLimitStore();
    const t0 = 6_000_000;
    expect(hit("k", 1, 1000, t0, store).allowed).toBe(true);
    expect(hit("k", 1, 1000, t0, store).allowed).toBe(false);
    store.clear();
    expect(hit("k", 1, 1000, t0, store).allowed).toBe(true);
  });
});

describe("clientKey", () => {
  it("uses the first X-Forwarded-For hop", () => {
    const req = new Request("https://x/y", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientKey(req, "search")).toBe("search:203.0.113.7");
  });

  it("falls back to a shared bucket when the header is absent", () => {
    const req = new Request("https://x/y");
    expect(clientKey(req, "search")).toBe("search:unknown");
  });
});

describe("tooManyRequests", () => {
  it("returns a 429 with a Retry-After header", async () => {
    const res = tooManyRequests({ allowed: false, retryAfter: 42, remaining: 0 });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBe(42);
  });
});
