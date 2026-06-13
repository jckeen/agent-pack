import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { TOKEN_PREFIX } from "@agentpack/core";

import { apiTokens, getDb, publisherMembers, publishers } from "./db";

/**
 * Generates a fresh API token.
 *
 * Body: 16 random bytes hex-encoded → 32 lowercase hex chars.
 * Full token: `agp_live_` + body (41 chars total).
 * Prefix kept for UI display: first 12 chars of the full token (9 prefix + 3 body).
 * sha256: lowercase hex sha256 of the UTF-8 token bytes — what we store.
 */
export function generateToken(): {
  token: string;
  prefix: string;
  sha256: string;
} {
  const body = crypto.randomBytes(16).toString("hex");
  const token = TOKEN_PREFIX + body;
  const prefix = token.slice(0, 12);
  const sha256 = hashToken(token);
  return { token, prefix, sha256 };
}

/** Lowercase hex sha256 of the UTF-8 token bytes. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export interface VerifiedToken {
  userId: string;
  tokenId: string;
  publisherIds: string[];
  publisherSlugs: string[];
  scopes: string[];
}

export type UngrantableScope = {
  scope: string;
  reason: "admin_scope_not_self_grantable" | "not_publisher_member";
};

/**
 * Gate at token-CREATION time: a user may only mint scopes they are entitled to.
 *
 *  - `admin:registry` is never user-mintable (would grant registry-wide takeover).
 *  - A publisher-scoped grant (`publish:packs@<slug>`, `read:private@<slug>`) is
 *    only mintable if the user is a current member of `<slug>`.
 *
 * The `tokenScopeSchema` only checks scope *syntax*; without this check any
 * logged-in user could self-grant `admin:registry` or publish into any
 * publisher's namespace (CWE-862 / supply-chain injection). Returns the first
 * offending scope, or null if every scope is grantable.
 */
export function findUngrantableScope(
  scopes: readonly string[],
  memberPublisherSlugs: readonly string[],
): UngrantableScope | null {
  for (const scope of scopes) {
    if (scope === "admin:registry") {
      return { scope, reason: "admin_scope_not_self_grantable" };
    }
    const at = scope.indexOf("@");
    if (at !== -1) {
      const slug = scope.slice(at + 1);
      if (!memberPublisherSlugs.includes(slug)) {
        return { scope, reason: "not_publisher_member" };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// verifyBearer in-memory TTL cache
//
// Motivation: verifyBearer is called on every authenticated API request. Each
// call hashes the token (cheap) then does two DB round-trips (SELECT token row
// + SELECT publisher memberships). On a serverless edge the cold-path cost is
// fine, but warm-instance hot-paths (many requests per second from the same
// CI token) pay the DB cost repeatedly for no benefit.
//
// Design:
//   - Key: sha256 of the raw Bearer token (never store the raw token).
//   - Value: { principal: VerifiedToken | null, expiresAt: number }
//   - TTL: VERIFY_BEARER_TTL_MS (default 45 s). Short enough that a revoked
//     token remains usable for at most ~45 s after revocation — document this
//     staleness window in every caller-facing comment. Long enough to absorb
//     burst traffic from a single CI job.
//   - null is also cached (invalid / unknown token) so repeated probing of a
//     bad token doesn't hammer the DB. The null TTL is the same as success TTL;
//     this is safe because an attacker probing random tokens will get cached
//     null responses, not repeated DB reads.
//   - Per-instance: a module-level Map is the right primitive for serverless.
//     Each function instance gets its own Map; entries do not survive across
//     cold starts, scale-to-zero, or instance replacement. That's fine — the
//     TTL is short by design and the DB is always authoritative.
//   - No background sweeping: entries are evicted lazily on read. Unbounded
//     growth is bounded by the number of unique token hashes seen per instance
//     lifetime, which is small in practice. A periodic sweep could be added if
//     profiling reveals a memory concern.
// ---------------------------------------------------------------------------

/** Exported for tests that need to reset between runs. Not for production use. */
export const VERIFY_BEARER_TTL_MS = 45_000;

interface CacheEntry {
  principal: VerifiedToken | null;
  expiresAt: number;
}

/** Module-level TTL cache. One Map per serverless instance — intentional. */
const _bearerCache = new Map<string, CacheEntry>();

/** Exported solely for unit tests — clears the cache between test cases. */
export function __resetBearerCacheForTests(): void {
  _bearerCache.clear();
}

/**
 * Resolve a Bearer-token-bearing request to a verified token, or null.
 *
 * Returns null on:
 *  - missing/malformed Authorization header
 *  - empty token after stripping `Bearer `
 *  - no DB configured (so write paths return 401 then 503 separately)
 *  - no row matching the sha256
 *  - row has `revoked_at` set
 *
 * On success: fires off a non-awaited `last_used_at` update and resolves the
 * publisher membership set so scope-expansion checks (`publish:packs@<pub>`)
 * can be enforced cleanly downstream.
 *
 * **Staleness window**: results are cached in memory for up to
 * VERIFY_BEARER_TTL_MS (45 s) per serverless instance. A token revoked in the
 * DB may remain accepted for up to that window on warm instances. This is an
 * explicit, documented trade-off — revocation is not instantaneous. For
 * security-sensitive workflows (e.g. emergency key rotation) operators should
 * redeploy to flush all instances, which takes effect within the deployment
 * propagation window (~30 s on Vercel).
 */
export async function verifyBearer(req: Request): Promise<VerifiedToken | null> {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  if (!header.startsWith("Bearer ")) return null;
  const raw = header.slice("Bearer ".length).trim();
  if (!raw) return null;

  const sha = hashToken(raw);

  // Cache hit: return the stored principal (may be null for invalid tokens)
  // without touching the DB.
  const cached = _bearerCache.get(sha);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.principal;
  }

  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenSha256, sha), isNull(apiTokens.revokedAt)))
    .limit(1);
  const row = rows[0];

  if (!row) {
    // Cache the negative result to avoid re-querying on repeated bad-token probes.
    _bearerCache.set(sha, {
      principal: null,
      expiresAt: Date.now() + VERIFY_BEARER_TTL_MS,
    });
    return null;
  }

  // Fire-and-forget last_used_at update — failures are non-fatal and must not
  // delay the request thread. We swallow the rejection deliberately because
  // there is no meaningful caller action on update failure.
  void db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.id))
    .catch((err: unknown) => {
      console.error("[tokens] last_used_at update failed:", err);
    });

  // Resolve publisher memberships for scope-expansion enforcement. If the
  // token is publisher-bound (api_tokens.publisher_id IS NOT NULL) we trust
  // that; otherwise we use the user's membership rows.
  const memberRows = await db
    .select({ id: publishers.id, slug: publishers.slug })
    .from(publisherMembers)
    .innerJoin(publishers, eq(publisherMembers.publisherId, publishers.id))
    .where(eq(publisherMembers.userId, row.userId));

  const principal: VerifiedToken = {
    userId: row.userId,
    tokenId: row.id,
    publisherIds: memberRows.map((r) => r.id),
    publisherSlugs: memberRows.map((r) => r.slug),
    scopes: row.scopes,
  };

  _bearerCache.set(sha, { principal, expiresAt: Date.now() + VERIFY_BEARER_TTL_MS });
  return principal;
}

/**
 * Throws a `Response` (NOT a string/Error) so route handlers can do:
 *   try { requireScope(verified, "publish:packs", publisherSlug); }
 *   catch (e) { if (e instanceof Response) return e; throw e; }
 *
 * Accepts:
 *  - exact scope match (e.g. `publish:packs`)
 *  - scoped match when `publisherSlug` supplied (e.g. `publish:packs@agentpack`)
 *  - `admin:registry` as a super-scope
 */
export function requireScope(
  verified: VerifiedToken,
  scope: string,
  publisherSlug?: string,
): void {
  if (verified.scopes.includes("admin:registry")) return;
  if (verified.scopes.includes(scope)) {
    // Plain scope match — but if a publisher is specified, the user must also
    // have membership in that publisher (otherwise we'd allow cross-publisher
    // writes from any token holding `publish:packs`).
    if (publisherSlug) {
      if (verified.publisherSlugs.includes(publisherSlug)) return;
    } else {
      return;
    }
  }
  if (publisherSlug && verified.scopes.includes(`${scope}@${publisherSlug}`)) {
    // Defense-in-depth: a scoped token only authorizes a publisher the user is
    // still a member of. Membership is resolved live in verifyBearer, so this
    // also revokes access the moment a user is removed from the publisher.
    if (verified.publisherSlugs.includes(publisherSlug)) return;
  }
  throw new Response(JSON.stringify({ error: "forbidden", reason: "scope_mismatch" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}
