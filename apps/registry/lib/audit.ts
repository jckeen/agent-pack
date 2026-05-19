/**
 * Audit event helper — appends a new row to `audit_events` with a hash
 * chain. v0.4 has only one chain (no orgs); the chain key is `orgId IS NULL`.
 *
 * Phase 6 will introduce per-org chains; this module then accepts an
 * optional `orgId` and partitions the chain lookup. For now the surface is
 * narrow: callers pass actor, action, target shape, and a payload object.
 */

import crypto from "node:crypto";
import { desc, eq, isNull } from "drizzle-orm";

import { auditEvents, type Database } from "./db";

export interface AppendAuditEventOptions {
  db: Database;
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
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`
    )
    .join(",")}}`;
}

/**
 * Insert an audit event with `entry_checksum` chained off the most recent
 * entry on the same chain (`org_id` partition). Returns the new row's id.
 */
export async function appendAuditEvent(
  opts: AppendAuditEventOptions
): Promise<string> {
  const { db, actorUserId, action, targetType, targetId, payload, orgId } =
    opts;

  // Find the chain head — latest row with the same org partition.
  const headRows = await db
    .select({ id: auditEvents.id, entryChecksum: auditEvents.entryChecksum })
    .from(auditEvents)
    .where(orgId ? eq(auditEvents.orgId, orgId) : isNull(auditEvents.orgId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);

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

  const inserted = await db
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
}
