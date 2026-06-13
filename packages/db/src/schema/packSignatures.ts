/**
 * `pack_signatures` — Sigstore keyless signatures attached to pack versions.
 *
 * One row per signature. A version may be unsigned (zero rows), signed once,
 * or re-signed (multiple rows; the latest by `signed_at` wins on display
 * but verification works against all rows so historical proofs survive).
 *
 * Source: `Plans/ROADMAP.md` § Phase 4 + `Plans/PHASE-6-GATE.md` (table is
 * NOT gated; it ships in v0.4.0 with the rest of Phase 4).
 */

import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { packVersions } from "./packVersions.js";

export const packSignatures = pgTable(
  "pack_signatures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packVersionId: uuid("pack_version_id")
      .notNull()
      .references(() => packVersions.id, { onDelete: "cascade" }),

    // Base64 Sigstore Bundle JSON — authoritative for verification.
    bundleB64: text("bundle_b64").notNull(),

    // Surface fields decoded from the bundle for display + identity gating.
    // Duplicated from the bundle so the registry can index/filter without
    // re-parsing the bundle on every read.
    signerSan: text("signer_san").notNull(),
    signerIssuer: text("signer_issuer").notNull(),

    // Rekor inclusion proof coordinates — enable cross-checking against the
    // public Rekor instance even years later.
    rekorLogIndex: bigint("rekor_log_index", { mode: "number" }).notNull(),
    rekorLogId: text("rekor_log_id").notNull(),
    rekorLogUrl: text("rekor_log_url").notNull(),

    // Manifest digest that the bundle signed. Always equals
    // `pack_versions.manifest_sha256`, kept here for a single-table proof.
    manifestSha256: text("manifest_sha256").notNull(),

    // Envelope version — bump on schema changes to the encoded payload.
    envelopeVersion: integer("envelope_version").notNull().default(1),

    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pkgVersionIdx: index("pack_signatures_pack_version_idx").on(t.packVersionId),
    rekorLogIdx: index("pack_signatures_rekor_log_index_idx").on(t.rekorLogIndex),
    // Index present in 0002_signatures.sql but absent from the original Drizzle schema;
    // added here to eliminate the drift between hand-written SQL and the schema object.
    signerSanIdx: index("pack_signatures_signer_san_idx").on(t.signerSan),
  }),
);

export type PackSignature = typeof packSignatures.$inferSelect;
export type PackSignatureInsert = typeof packSignatures.$inferInsert;
