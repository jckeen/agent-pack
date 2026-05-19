import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { TOKEN_PREFIX } from "@workgraph/core";

import { apiTokens, getDb, publisherMembers, publishers } from "./db";

/**
 * Generates a fresh API token.
 *
 * Body: 16 random bytes hex-encoded → 32 lowercase hex chars.
 * Full token: `wgp_live_` + body (41 chars total).
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
 */
export async function verifyBearer(req: Request): Promise<VerifiedToken | null> {
  const header =
    req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  if (!header.startsWith("Bearer ")) return null;
  const raw = header.slice("Bearer ".length).trim();
  if (!raw) return null;

  const sha = hashToken(raw);
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenSha256, sha), isNull(apiTokens.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

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

  return {
    userId: row.userId,
    tokenId: row.id,
    publisherIds: memberRows.map((r) => r.id),
    publisherSlugs: memberRows.map((r) => r.slug),
    scopes: row.scopes,
  };
}

/**
 * Throws a `Response` (NOT a string/Error) so route handlers can do:
 *   try { requireScope(verified, "publish:packs", publisherSlug); }
 *   catch (e) { if (e instanceof Response) return e; throw e; }
 *
 * Accepts:
 *  - exact scope match (e.g. `publish:packs`)
 *  - scoped match when `publisherSlug` supplied (e.g. `publish:packs@workgraph`)
 *  - `admin:registry` as a super-scope
 */
export function requireScope(
  verified: VerifiedToken,
  scope: string,
  publisherSlug?: string
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
    return;
  }
  throw new Response(
    JSON.stringify({ error: "forbidden", reason: "scope_mismatch" }),
    {
      status: 403,
      headers: { "content-type": "application/json" },
    }
  );
}
