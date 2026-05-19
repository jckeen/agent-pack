/**
 * `pack_versions` — one row per published version of a pack.
 *
 * Column shape pinned by `Plans/PROTOCOL.md` § 4. Status enum mirrors
 * `versionStatusSchema` from `@workgraph/core/protocol`.
 */

import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { packs } from "./packs.js";
import { users } from "./users.js";

export const VERSION_STATUS = [
  "published",
  "deprecated",
  "yanked",
  "quarantined",
  "blocked",
] as const;

export type VersionStatusEnum = (typeof VERSION_STATUS)[number];

export const versionStatusEnum = pgEnum("pack_version_status", VERSION_STATUS);

export const packVersions = pgTable(
  "pack_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packId: uuid("pack_id")
      .notNull()
      .references(() => packs.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    status: versionStatusEnum("status").notNull().default("published"),
    manifestSha256: text("manifest_sha256").notNull(),
    manifestR2Key: text("manifest_r2_key").notNull(),
    readmeR2Key: text("readme_r2_key"),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    publishedBy: uuid("published_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => ({
    packVersionUq: uniqueIndex("pack_versions_pack_version_uq").on(
      t.packId,
      t.version
    ),
  })
);

export type PackVersion = typeof packVersions.$inferSelect;
export type NewPackVersion = typeof packVersions.$inferInsert;
