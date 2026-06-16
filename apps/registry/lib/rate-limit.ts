/**
 * Minimal fixed-window rate limiter with a pluggable backing store.
 *
 * The default store is an in-process `Map` (`MemoryRateLimitStore`). That is the
 * right-sized default for a single-instance OSS registry and adds no
 * infrastructure dependency.
 *
 * IMPORTANT — production topology caveat: the in-memory store is PER-INSTANCE.
 * On a horizontally-scaled serverless deployment (e.g. Vercel) each function
 * instance keeps its own Map and instances scale out + reset on cold start, so
 * the effective ceiling is `limit × instanceCount`, not `limit`. Treat the
 * per-publisher/per-token DB-level guards as the real abuse control there. The
 * production upgrade is a durable shared store (e.g. Vercel KV / Upstash Redis)
 * implementing `RateLimitStore` below — `hit()` takes the store as a parameter
 * so the adapter drops in with no call-site changes and no dependency added
 * here. See issue #37.
 *
 * backend-architect HIGH #2: there was previously no rate limiting anywhere.
 */

export interface RateLimitWindow {
  count: number;
  resetAt: number;
}

/**
 * Backing-store seam for the rate limiter. The default in-memory implementation
 * is `MemoryRateLimitStore`; a durable adapter (KV/Redis) can implement this
 * same interface to share state across instances. Methods are intentionally
 * synchronous to match the current call sites — an async durable adapter would
 * wrap these (the issue tracks the upgrade).
 */
export interface RateLimitStore {
  get(key: string): RateLimitWindow | undefined;
  set(key: string, window: RateLimitWindow): void;
  delete(key: string): void;
  clear(): void;
}

/** Default per-instance store: a module-lifetime `Map` with amortized sweeping. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, RateLimitWindow>();
  private lastSweep = 0;

  get(key: string): RateLimitWindow | undefined {
    return this.windows.get(key);
  }

  set(key: string, window: RateLimitWindow): void {
    // Amortized cleanup so the Map can't grow unbounded under key churn.
    if (window.resetAt - this.lastSweep >= 60_000) {
      this.lastSweep = window.resetAt;
      for (const [k, w] of this.windows) {
        if (w.resetAt < window.resetAt) this.windows.delete(k);
      }
    }
    this.windows.set(key, window);
  }

  delete(key: string): void {
    this.windows.delete(key);
  }

  clear(): void {
    this.windows.clear();
    this.lastSweep = 0;
  }
}

/** The default store used by `hit()` when no store is injected. */
const defaultStore = new MemoryRateLimitStore();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (for Retry-After). */
  retryAfter: number;
  remaining: number;
}

/**
 * Record one hit against `key` and report whether it's within `limit` per
 * `windowMs`. Fixed-window (not strictly sliding) — adequate for abuse control
 * and cheap. `now` is injectable for tests; `store` defaults to the per-instance
 * in-memory store but accepts any `RateLimitStore` (the durable-adapter seam).
 */
export function hit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
  store: RateLimitStore = defaultStore,
): RateLimitResult {
  const existing = store.get(key);
  if (!existing || existing.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0, remaining: limit - 1 };
  }
  existing.count += 1;
  store.set(key, existing);
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

/** Test-only: clear the default store's windows. */
export function __resetRateLimit(): void {
  defaultStore.clear();
}
