/**
 * `publishes` — two-phase publish state.
 *
 * Lifecycle: row inserted at `/api/publish/init` with `status='pending'` and
 * `expires_at = now() + 24h`. `presigned_files` captures the file shape from
 * the init request so finalize can re-verify size against R2 HEAD without
 * re-trusting client input. On `/api/publish/.../finalize` the row flips to
 * `status='completed'` (linked to `packs.id`). Expired (>24h) finalize → 410
 * Gone + status='aborted'.
 */

import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { packs } from "./packs.js";
import { users } from "./users.js";

export const PUBLISH_STATUS = ["pending", "aborted", "completed"] as const;
export type PublishStatus = (typeof PUBLISH_STATUS)[number];

/**
 * Shape of each entry in `presigned_files`. Mirrors `PublishFileEntry` in
 * `@agentpack/core/protocol`. Kept inline (not imported) so the DB package
 * has zero dependency on `@agentpack/core` at runtime; the protocol module
 * is the source of truth for the wire shape.
 */
export interface PresignedFileEntry {
  path: string;
  sha256: string;
  bytes: number;
  atomId?: string;
  r2Key: string;
  presignedUrl: string;
  presignedHeaders: Record<string, string>;
}

export const publishes = pgTable("publishes", {
  id: uuid("id").primaryKey().defaultRandom(),
  publisherSlug: text("publisher_slug").notNull(),
  packSlug: text("pack_slug").notNull(),
  version: text("version").notNull(),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  packId: uuid("pack_id").references(() => packs.id, { onDelete: "set null" }),
  presignedFiles: jsonb("presigned_files")
    .notNull()
    .$type<PresignedFileEntry[]>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Publish = typeof publishes.$inferSelect;
export type NewPublish = typeof publishes.$inferInsert;
