import { and, eq, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { apiTokens, type ApiToken, type NewApiToken } from "../schema/index.js";

export async function findActiveTokenByHash(
  db: Database,
  sha256: string
): Promise<ApiToken | null> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenSha256, sha256), isNull(apiTokens.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export interface MintTokenInput {
  userId: string;
  publisherId?: string | null;
  name: string;
  tokenPrefix: string;
  tokenSha256: string;
  scopes: string[];
}

export async function mintToken(
  db: Database,
  input: MintTokenInput
): Promise<ApiToken> {
  const row: NewApiToken = {
    userId: input.userId,
    publisherId: input.publisherId ?? null,
    name: input.name,
    tokenPrefix: input.tokenPrefix,
    tokenSha256: input.tokenSha256,
    scopes: input.scopes,
  };
  const inserted = await db.insert(apiTokens).values(row).returning();
  if (!inserted[0]) {
    throw new Error("mintToken: insert returned no row");
  }
  return inserted[0];
}

export async function revokeToken(
  db: Database,
  tokenId: string,
  userId: string
): Promise<boolean> {
  const result = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
    .returning({ id: apiTokens.id });
  return result.length > 0;
}

export async function listUserTokens(
  db: Database,
  userId: string
): Promise<ApiToken[]> {
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId));
}

export async function markTokenUsed(
  db: Database,
  tokenId: string
): Promise<void> {
  await db
    .update(apiTokens)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(apiTokens.id, tokenId));
}
