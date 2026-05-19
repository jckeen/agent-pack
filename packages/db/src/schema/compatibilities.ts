/**
 * `compatibilities` — per-target compatibility status for each pack version.
 *
 * Composite PK `(pack_version_id, target)`. Status is a free-form text matching
 * `compatibilityStatusSchema` in `@workgraph/core/protocol`
 * (`supported|partial|experimental|unsupported`).
 */

import { pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";

import { packVersions } from "./packVersions.js";

export const compatibilities = pgTable(
  "compatibilities",
  {
    packVersionId: uuid("pack_version_id")
      .notNull()
      .references(() => packVersions.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
    status: text("status").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.packVersionId, t.target] }),
  })
);

export type Compatibility = typeof compatibilities.$inferSelect;
export type NewCompatibility = typeof compatibilities.$inferInsert;
