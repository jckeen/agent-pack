/**
 * `publishers` + `publisher_members` — publisher organizations and their
 * member users.
 *
 * Column shape pinned by `Plans/PROTOCOL.md` § 4.
 */

import {
  boolean,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { users } from "./users.js";

export const publishers = pgTable("publishers", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type Publisher = typeof publishers.$inferSelect;
export type NewPublisher = typeof publishers.$inferInsert;

/**
 * Composite PK `(publisher_id, user_id)`. `role` is `'owner'` or
 * `'maintainer'` — owners can manage members + revoke tokens; maintainers can
 * publish only.
 */
export const publisherMembers = pgTable(
  "publisher_members",
  {
    publisherId: uuid("publisher_id")
      .notNull()
      .references(() => publishers.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.publisherId, t.userId] }),
  })
);

export type PublisherMember = typeof publisherMembers.$inferSelect;
export type NewPublisherMember = typeof publisherMembers.$inferInsert;
export type PublisherRole = "owner" | "maintainer";
