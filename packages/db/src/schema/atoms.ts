/**
 * `atoms` — one row per atom in a published pack version.
 *
 * Column shape pinned by `Plans/PROTOCOL.md` § 4.
 */

import { jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { packVersions } from "./packVersions.js";

export const atoms = pgTable(
  "atoms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packVersionId: uuid("pack_version_id")
      .notNull()
      .references(() => packVersions.id, { onDelete: "cascade" }),
    atomId: text("atom_id").notNull(),
    type: text("type").notNull(),
    riskLevel: text("risk_level").notNull(),
    metadata: jsonb("metadata").notNull().$type<Record<string, unknown>>(),
  },
  (t) => ({
    packAtomUq: uniqueIndex("atoms_pack_atom_uq").on(t.packVersionId, t.atomId),
  })
);

export type AtomRow = typeof atoms.$inferSelect;
export type NewAtomRow = typeof atoms.$inferInsert;
