/**
 * `reviews` — pack-version reviews. Schema only in v0.3; POST endpoint
 * returns 501 per ROADMAP D3.7.
 */

import {
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { packVersions } from "./packVersions.js";
import { users } from "./users.js";

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  packVersionId: uuid("pack_version_id")
    .notNull()
    .references(() => packVersions.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  rating: smallint("rating").notNull(),
  body: text("body").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
