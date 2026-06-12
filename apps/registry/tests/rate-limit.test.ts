import { afterEach, describe, expect, it } from "vitest";

import { __resetRateLimit, clientKey, hit, tooManyRequests } from "@/lib/rate-limit";

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
