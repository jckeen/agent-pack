/**
 * Look up the current status (and quarantine reason, if any) for a pack
 * version. Used by the pack detail page to decide whether to render the
 * QuarantineBanner instead of the InstallCommandBox.
 *
 * Returns null in JSON-fallback mode (no DB). Seed packs are always treated
 * as `published` — quarantine is a DB-backed concern only.
 */

import { and, desc, eq } from "drizzle-orm";

import {
  auditEvents,
  getDb,
  packVersions,
  packs,
  publishers,
} from "./db";

export interface VersionStatusInfo {
  status: string;
  reason: string | null;
}

export async function getVersionStatus(
  publisher: string,
  packSlug: string,
  version: string
): Promise<VersionStatusInfo | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select({
      versionId: packVersions.id,
      status: packVersions.status,
    })
    .from(packVersions)
    .innerJoin(packs, eq(packs.id, packVersions.packId))
    .innerJoin(publishers, eq(publishers.id, packs.publisherId))
    .where(
      and(
        eq(publishers.slug, publisher),
        eq(packs.slug, packSlug),
        eq(packVersions.version, version)
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.status !== "quarantined") {
    return { status: row.status, reason: null };
  }

  // Quarantined — fetch the last `version_status_changed` audit event for
  // this version to pull the reason out of the payload.
  const auditRows = await db
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "pack_version"),
        eq(auditEvents.targetId, row.versionId),
        eq(auditEvents.action, "version_status_changed")
      )
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);

  const payload = auditRows[0]?.payload as
    | { reason?: string | null; new_status?: string }
    | undefined;
  const reason =
    payload && payload.new_status === "quarantined"
      ? (payload.reason ?? null)
      : null;

  return { status: row.status, reason };
}
