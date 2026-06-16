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
  type Database,
} from "@/lib/db";
import type { VersionStatusEnum } from "@agentpack/db";
import { appendAuditEvent, type AppendAuditEventOptions, type AuditDb } from "@/lib/audit";

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

export interface ApplyStatusChangeOptions {
  /** Root Drizzle db (or open transaction handle). */
  db: Database;
  /** Injected audit helper — defaults to the real appendAuditEvent. */
  appendAuditFn?: (opts: AppendAuditEventOptions) => Promise<string>;
  versionId: string;
  nextStatus: VersionStatusEnum;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
}

/**
 * Atomic: update pack_versions.status + append an audit event in a single
 * transaction. Extracted from the POST handler so the transaction body can be
 * unit-tested without Next.js session/DB dependencies (#58).
 *
 * If appendAuditFn throws, the status update rolls back — the invariant that
 * every quarantine has an audit record is enforced at the DB level (#36).
 */
export async function applyStatusChange(opts: ApplyStatusChangeOptions): Promise<string> {
  const { db, versionId, nextStatus, actorUserId, action, targetType, targetId, payload } = opts;
  const auditFn = opts.appendAuditFn ?? appendAuditEvent;

  return db.transaction(async (tx) => {
    await tx
      .update(packVersions)
      .set({ status: nextStatus })
      .where(eq(packVersions.id, versionId));

    return auditFn({
      db: tx as AuditDb,
      actorUserId,
      action,
      targetType,
      targetId,
      payload,
    });
  });
}

/**
 * Origin/Sec-Fetch-Site CSRF guard for the admin POST. NextAuth v5 only
 * protects its own `/api/auth/*` endpoints, not arbitrary app POSTs. An
 * attacker page can auto-POST with `credentials:'include'` and the user's
 * session cookie tags along. Reject any request whose Origin doesn't match
 * the deployed registry URL, and require a content-type the simple-request
 * CORS rules can't construct (application/json). From security-reviewer
 * HIGH-3 (iter-5).
 */
function csrfGuard(req: Request): Response | null {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    return NextResponse.json(
      { error: "csrf_content_type", message: "Content-Type must be application/json" },
      { status: 415 },
    );
  }
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return NextResponse.json(
      { error: "csrf_origin", message: "Cross-origin admin write rejected" },
      { status: 403 },
    );
  }
  const origin = req.headers.get("origin");
  const expected = process.env.NEXT_PUBLIC_REGISTRY_URL?.replace(/\/$/, "");
  if (origin && expected && origin !== expected) {
    return NextResponse.json(
      { error: "csrf_origin", message: "Origin does not match deployed registry" },
      { status: 403 },
    );
  }
  return null;
}

export async function POST(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ publisher: string; pack: string; version: string }>;
  }
): Promise<Response> {
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

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

  // Atomic: the status flip and its audit row commit together or not at all.
  // A failure between them would leave a quarantined version with no audit
  // record (getVersionStatus would then render the banner with reason: null),
  // breaking the governance integrity story. The advisory-lock + FOR UPDATE
  // head select inside appendAuditEvent nest fine under this outer tx (the
  // passed `tx` opens a savepoint). From #36.
  const auditEventId = await applyStatusChange({
    db,
    versionId: row.versionId,
    nextStatus,
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
