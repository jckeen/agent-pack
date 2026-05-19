/**
 * `audit_events` — Phase 6 reserved. Self-referential FK forms the audit
 * hash chain (`previous_entry_id` → prior row), and `entry_checksum`
 * canonicalizes the row's content. Empty in v0.3; populated when org
 * scoping ships.
 */

import {
  AnyPgColumn,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { users } from "./users.js";

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id"),
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  /**
   * Self-FK forming the immutable chain root. Drizzle requires a typed
   * thunk for self-references; see drizzle docs § "Foreign keys" for the
   * `AnyPgColumn` pattern.
   */
  previousEntryId: uuid("previous_entry_id").references(
    (): AnyPgColumn => auditEvents.id,
    { onDelete: "restrict" }
  ),
  entryChecksum: text("entry_checksum").notNull(),
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
