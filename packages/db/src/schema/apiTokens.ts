/**
 * `api_tokens` — hashed bearer tokens for CLI publish/read.
 *
 * Pinned by PROTOCOL.md § 1 + § 4. The plaintext token is shown to the user
 * exactly once at mint time; storage is `sha256(token)` lowercase hex.
 * `token_sha256` is unique so the lookup is `where token_sha256 = $1`.
 */

import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { publishers } from "./publishers.js";
import { users } from "./users.js";

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publisherId: uuid("publisher_id").references(() => publishers.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenSha256: text("token_sha256").notNull(),
    /**
     * Array of scope strings — matches `tokenScopeSchema` in
     * `@agentpack/core/protocol`. Stored as jsonb so we can index by scope
     * with `jsonb_path_ops` later if needed.
     */
    scopes: jsonb("scopes").notNull().$type<string[]>(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    tokenSha256Uq: uniqueIndex("api_tokens_token_sha256_uq").on(t.tokenSha256),
  })
);

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
