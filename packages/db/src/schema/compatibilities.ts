/**
 * `compatibilities` — per-target compatibility status for each pack version.
 *
 * Composite PK `(pack_version_id, target)`. Status is a free-form text matching
 * `compatibilityStatusSchema` in `@agentpack/core/protocol`
 * (`supported|partial|experimental|unsupported`).
 */

import { check, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    // Closed domain from `compatibilityStatusSchema` in @agentpack/core.
    // Kept as text + CHECK rather than pgEnum to stay non-destructive.
    statusCheck: check(
      "compatibilities_status_check",
      sql`${t.status} in ('supported', 'partial', 'experimental', 'unsupported')`,
    ),
  }),
);

export type Compatibility = typeof compatibilities.$inferSelect;
export type NewCompatibility = typeof compatibilities.$inferInsert;
