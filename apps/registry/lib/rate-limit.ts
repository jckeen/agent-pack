/**
 * Minimal in-memory sliding-window rate limiter.
 *
 * The OSS registry defaults to a single instance, so an in-process limiter is
 * the right-sized default — it closes the worst abuse vectors (unauthenticated
 * FTS scans, device-code enumeration, publish-init R2-presign spam) without a
 * Redis dependency. For a horizontally-scaled deployment, swap `hit()` for a
 * Redis INCR + EXPIRE behind the same signature; nothing else changes.
 *
 * backend-architect HIGH #2: there was previously no rate limiting anywhere.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
let lastSweep = 0;

function sweep(now: number): void {
  // Amortized cleanup so the Map can't grow unbounded under key churn.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, w] of windows) {
    if (w.resetAt < now) windows.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (for Retry-After). */
  retryAfter: number;
  remaining: number;
}

/**
 * Record one hit against `key` and report whether it's within `limit` per
 * `windowMs`. Fixed-window (not strictly sliding) — adequate for abuse control
 * and cheap. `now` is injectable for tests.
 */
export function hit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  sweep(now);
  const existing = windows.get(key);
  if (!existing || existing.resetAt < now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0, remaining: limit - 1 };
  }
  existing.count += 1;
  if (existing.count > limit) {
    return {
      allowed: false,
      retryAfter: Math.ceil((existing.resetAt - now) / 1000),
      remaining: 0,
    };
  }
  return {
    allowed: true,
    retryAfter: 0,
    remaining: Math.max(0, limit - existing.count),
  };
}

/**
 * Best-effort client key for anonymous routes: the first hop of
 * X-Forwarded-For, else a fixed bucket (so a misconfigured proxy degrades to a
 * shared global limit rather than no limit).
 */
export function clientKey(req: Request, scope: string): string {
  const xff = req.headers.get("x-forwarded-for");
  const ip = xff?.split(",")[0]?.trim() || "unknown";
  return `${scope}:${ip}`;
}

/** Build a 429 JSON response with a Retry-After header. */
export function tooManyRequests(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", retryAfter: result.retryAfter }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(result.retryAfter),
      },
    },
  );
}

/** Test-only: clear all windows. */
export function __resetRateLimit(): void {
  windows.clear();
  lastSweep = 0;
}
