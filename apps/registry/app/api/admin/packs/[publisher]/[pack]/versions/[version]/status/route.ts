/**
 * POST /api/admin/packs/{publisher}/{pack}/versions/{version}/status
 *
 * Sets `pack_versions.status` to "active" (mapped to enum `published`) or
 * "quarantined" with an audit_events row. Session-cookie-authenticated (NOT
 * Bearer-token; v0.4 admin is web-UI-only).
 *
 * Role gate: requester must be a publisher_members row with role='owner'
 * for the target publisher. There is no registry-admin role in v0.4 — only
 * pack owners can quarantine their own versions. Block (registry-admin-only
 * per ROADMAP D4.4) is intentionally excluded from this v0.4 surface.
 *
 * Returns:
 *  - 200 + { status, version, previous_status, audit_event_id }
 *  - 401 if no session
 *  - 403 if user not a publisher owner
 *  - 404 if pack or version not found
 *  - 422 if body invalid (missing reason for quarantine, oversized reason)
 *  - 503 if db_unconfigured
 */

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  getDb,
  packVersions,
  packs,
  publisherMembers,
  publishers,
} from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";

const requestSchema = z
  .object({
    status: z.enum(["active", "quarantined"]),
    reason: z.string().min(1).max(500).optional(),
  })
  .refine(
    (b) => b.status === "active" || (b.reason != null && b.reason.length > 0),
    {
      message: "reason required when quarantining",
      path: ["reason"],
    }
  );

export async function POST(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ publisher: string; pack: string; version: string }>;
  }
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "db_unconfigured" }, { status: 503 });
  }

  const { publisher, pack, version } = await params;

  let body: { status: "active" | "quarantined"; reason?: string };
  try {
    const raw = (await req.json()) as unknown;
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_body", issues: parsed.error.issues },
        { status: 422 }
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 422 });
  }

  // Resolve the version row + publisher in one join.
  const versionRow = await db
    .select({
      versionId: packVersions.id,
      packId: packs.id,
      publisherId: publishers.id,
      previousStatus: packVersions.status,
    })
    .from(packVersions)
    .innerJoin(packs, eq(packs.id, packVersions.packId))
    .innerJoin(publishers, eq(publishers.id, packs.publisherId))
    .where(
      and(
        eq(publishers.slug, publisher),
        eq(packs.slug, pack),
        eq(packVersions.version, version)
      )
    )
    .limit(1);

  const row = versionRow[0];
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Role gate: requester must own the publisher. v0.4 has no
  // registry-admin role; only pack owners can flip status on their own packs.
  const memberRows = await db
    .select({ role: publisherMembers.role })
    .from(publisherMembers)
    .where(
      and(
        eq(publisherMembers.publisherId, row.publisherId),
        eq(publisherMembers.userId, session.user.id)
      )
    )
    .limit(1);
  if (memberRows[0]?.role !== "owner") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const nextStatus = body.status === "active" ? "published" : "quarantined";

  await db
    .update(packVersions)
    .set({ status: nextStatus })
    .where(eq(packVersions.id, row.versionId));

  const auditEventId = await appendAuditEvent({
    db,
    actorUserId: session.user.id,
    action: "version_status_changed",
    targetType: "pack_version",
    targetId: row.versionId,
    payload: {
      publisher,
      pack,
      version,
      previous_status: row.previousStatus,
      new_status: nextStatus,
      reason: body.reason ?? null,
    },
  });

  return NextResponse.json({
    status: nextStatus,
    version,
    previous_status: row.previousStatus,
    audit_event_id: auditEventId,
  });
}
