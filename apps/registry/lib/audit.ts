/**
 * Audit event helper — appends a new row to `audit_events` with a hash
 * chain. v0.4 has only one chain (no orgs); the chain key is `orgId IS NULL`.
 *
 * Phase 6 will introduce per-org chains; this module then accepts an
 * optional `orgId` and partitions the chain lookup. For now the surface is
 * narrow: callers pass actor, action, target shape, and a payload object.
 */

import crypto from "node:crypto";
import { desc, eq, isNull, sql } from "drizzle-orm";

import { auditEvents, type Database } from "./db";

/**
 * Either the top-level Drizzle client or an open transaction handle. Callers
 * inside an outer `db.transaction(...)` pass the `tx` so the audit row commits
 * atomically with their own writes (#36). A `PgTransaction` supports the same
 * `.transaction()` / `.select` / `.insert` surface used here — the nested call
 * opens a savepoint, and the advisory lock + `FOR UPDATE` head select nest
 * fine under the outer transaction.
 */
export type AuditDb = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface AppendAuditEventOptions {
  db: AuditDb;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  orgId?: string | null;
}

/** Canonical-JSON-style stringify: sorted keys, no whitespace. */
function canonicalize(obj: unknown): string {
  // JSON.stringify(undefined) returns undefined (not "undefined"), which
  // would coerce to the literal string "undefined" via `+` concat and
  // surprise the hash. Normalize to JSON null instead — same intent
  // ("no value") and deterministic.
  if (obj === undefined) return "null";
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/**
 * Insert an audit event with `entry_checksum` chained off the most recent
 * entry on the same chain (`org_id` partition). Returns the new row's id.
 *
 * **Concurrency-safe.** The head SELECT + INSERT run inside a transaction
 * with `SELECT ... FOR UPDATE` on the head row, serializing concurrent
 * `appendAuditEvent` calls so two callers can't both claim the same
 * `previous_entry_id` and fork the chain. From security-reviewer
 * CRITICAL-2 (iter-5). For Postgres backends; SQLite ignores `FOR UPDATE`
 * but its single-writer model already serializes.
 */
export async function appendAuditEvent(opts: AppendAuditEventOptions): Promise<string> {
  const { db, actorUserId, action, targetType, targetId, payload, orgId } = opts;

  return await db.transaction(async (tx) => {
    // Take a Postgres advisory lock keyed by the chain partition BEFORE
    // touching the head row. This is critical for the genesis case: when
    // the table is empty for this chain, `SELECT … FOR UPDATE` returns no
    // rows so two concurrent transactions can both observe "empty" and
    // both insert as genesis, forking the chain on its very first entry.
    // An advisory lock serializes ALL writers to the same chain regardless
    // of whether a head row exists yet. From codex P1 review (iter-5).
    //
    // Key: stable 64-bit hash of "audit:" + (orgId ?? "_null_"). 32-bit
    // form of `pg_advisory_xact_lock(int)` is plenty for collision
    // avoidance at the scale of orgs we expect.
    const chainKey = `audit:${orgId ?? "_null_"}`;
    const advisoryKey = signedInt32Hash(chainKey);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryKey})`);

    // Find the chain head INSIDE the transaction with row-level lock so no
    // other tx can read the same head and produce a forked chain.
    const headRows = await tx
      .select({ id: auditEvents.id, entryChecksum: auditEvents.entryChecksum })
      .from(auditEvents)
      .where(orgId ? eq(auditEvents.orgId, orgId) : isNull(auditEvents.orgId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(1)
      .for("update");

    const previousEntryId = headRows[0]?.id ?? null;
    const previousChecksum = headRows[0]?.entryChecksum ?? "";

    // Compute the new entry_checksum over the row content + previous checksum.
    const rowContent = {
      actorUserId,
      action,
      targetType,
      targetId,
      payload,
      orgId: orgId ?? null,
    };
    const entryChecksum = crypto
      .createHash("sha256")
      .update(previousChecksum + canonicalize(rowContent), "utf8")
      .digest("hex");

    const inserted = await tx
      .insert(auditEvents)
      .values({
        orgId: orgId ?? null,
        actorUserId,
        action,
        targetType,
        targetId,
        previousEntryId,
        entryChecksum,
        payload,
      })
      .returning({ id: auditEvents.id });

    return inserted[0]?.id ?? "";
  });
}

/**
 * Stable 32-bit signed-int hash of a string, suitable for
 * `pg_advisory_xact_lock(int)` (Postgres takes one bigint or two ints).
 * SHA-256 first 4 bytes folded into a signed int32 — deterministic and
 * collision-resistant for the small set of audit chain keys we expect.
 */
function signedInt32Hash(s: string): number {
  const digest = crypto.createHash("sha256").update(s, "utf8").digest();
  // Take first 4 bytes, interpret as signed big-endian int32.
  return digest.readInt32BE(0);
}
