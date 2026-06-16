/**
 * `publishers` + `publisher_members` — publisher organizations and their
 * member users.
 *
 * Column shape pinned by `Plans/PROTOCOL.md` § 4.
 */

import {
  boolean,
  check,
  index,
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
    // Hot auth path: the composite PK leads with publisher_id and can't serve
    // `WHERE user_id = $1` (verifyBearer, lib/auth, /api/me, admin status).
    userIdIdx: index("publisher_members_user_id_idx").on(t.userId),
    // `role` is a closed domain (`owner|maintainer`). Kept as text + CHECK
    // rather than a pgEnum to stay non-destructive (no text→enum USING cast).
    roleCheck: check(
      "publisher_members_role_check",
      sql`${t.role} in ('owner', 'maintainer')`,
    ),
  }),
);

export type PublisherMember = typeof publisherMembers.$inferSelect;
export type NewPublisherMember = typeof publisherMembers.$inferInsert;
export type PublisherRole = "owner" | "maintainer";
