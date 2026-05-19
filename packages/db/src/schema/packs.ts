/**
 * `packs` table — published pack identity (publisher + slug).
 *
 * Column shape pinned by `Plans/PROTOCOL.md` § 4.
 *
 * Notes:
 * - `search` is a Postgres `tsvector` generated column weighting name (A),
 *   description (B), and tags (C). Built via a `customType` so Drizzle treats
 *   it as a real column at type-inference time.
 * - `packs_search_idx` is a GIN index over `search` for FTS query speed.
 * - `latest_version_id` is set by the finalize-publish transaction; it's
 *   nullable because a pack exists before any version is finalized.
 */

import {
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { publishers } from "./publishers.js";

/**
 * Custom Postgres `tsvector` column type. Read as `string` in JS — drivers
 * return the textual representation when selected.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const packs = pgTable(
  "packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publisherId: uuid("publisher_id")
      .notNull()
      .references(() => publishers.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /**
     * Forward-ref to `pack_versions.id`. We don't declare a Drizzle FK here
     * because `pack_versions.pack_id` already points the other way and a
     * cyclic FK forces deferred-constraint mode at insert time. Migration
     * SQL adds an unenforced reference via comment.
     */
    latestVersionId: uuid("latest_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /**
     * Weighted FTS column. The migration SQL defines this as a stored
     * generated column with the exact expression pinned in the W1 spec:
     *
     *   setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
     *   setweight(to_tsvector('english', coalesce(description,'')), 'B') ||
     *   setweight(to_tsvector('english', array_to_string(coalesce(tags,'{}'),' ')), 'C')
     */
    search: tsvector("search").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(name,'')), 'A') || setweight(to_tsvector('english', coalesce(description,'')), 'B') || setweight(to_tsvector('english', array_to_string(coalesce(tags,'{}'),' ')), 'C')`
    ),
  },
  (t) => ({
    publisherSlugUq: uniqueIndex("packs_publisher_slug_uq").on(
      t.publisherId,
      t.slug
    ),
    searchIdx: index("packs_search_idx").using("gin", t.search),
  })
);

export type Pack = typeof packs.$inferSelect;
export type NewPack = typeof packs.$inferInsert;
