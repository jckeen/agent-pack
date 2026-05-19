/**
 * `pack_files` — one row per file in a published pack version's tree.
 *
 * Column shape pinned by `Plans/PROTOCOL.md` § 4. Indexed on
 * `(pack_version_id, path)` for fast streaming lookup during install.
 */

import { index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";

import { packVersions } from "./packVersions.js";

export const packFiles = pgTable(
  "pack_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packVersionId: uuid("pack_version_id")
      .notNull()
      .references(() => packVersions.id, { onDelete: "cascade" }),
    atomId: text("atom_id"),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    r2Key: text("r2_key").notNull(),
  },
  (t) => ({
    packVersionPathIdx: index("pack_files_pack_version_path_idx").on(
      t.packVersionId,
      t.path
    ),
  })
);

export type PackFile = typeof packFiles.$inferSelect;
export type NewPackFile = typeof packFiles.$inferInsert;
