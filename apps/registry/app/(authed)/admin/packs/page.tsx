/**
 * `/admin/packs` — pack version status admin. Owner-of-publisher only.
 *
 * Lists every pack the logged-in user owns (via `publisher_members.role=owner`),
 * with every version, current status, and inline quarantine/unquarantine form.
 *
 * Phase 6 will widen this to org admins. v0.4 sticks to owner-only.
 */

import { redirect } from "next/navigation";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";

import {
  getDb,
  packs,
  packVersions,
  publishers,
  publisherMembers,
} from "@/lib/db";
import { auth, signIn } from "@/lib/auth";
import { appendAuditEvent } from "@/lib/audit";

interface PageProps {
  searchParams: Promise<{ ok?: string; err?: string; version?: string }>;
}

interface OwnedVersionRow {
  publisherSlug: string;
  packSlug: string;
  packName: string | null;
  version: string;
  status: string;
  versionId: string;
  publishedAt: Date;
}

async function loadOwnedVersions(userId: string): Promise<OwnedVersionRow[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      publisherSlug: publishers.slug,
      packSlug: packs.slug,
      packName: packs.description,
      version: packVersions.version,
      status: packVersions.status,
      versionId: packVersions.id,
      publishedAt: packVersions.publishedAt,
    })
    .from(packVersions)
    .innerJoin(packs, eq(packs.id, packVersions.packId))
    .innerJoin(publishers, eq(publishers.id, packs.publisherId))
    .innerJoin(
      publisherMembers,
      and(
        eq(publisherMembers.publisherId, publishers.id),
        eq(publisherMembers.userId, userId)
      )
    )
    .where(eq(publisherMembers.role, "owner"))
    .orderBy(desc(packVersions.publishedAt));
  return rows;
}

async function setStatusAction(formData: FormData): Promise<void> {
  "use server";
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/admin/packs?err=unauthorized");
  }
  const publisher = String(formData.get("publisher") ?? "");
  const pack = String(formData.get("pack") ?? "");
  const version = String(formData.get("version") ?? "");
  const status = String(formData.get("status") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  if (!publisher || !pack || !version || !status) {
    redirect("/admin/packs?err=missing_fields");
  }
  if (status === "quarantined" && reason.length === 0) {
    redirect(
      `/admin/packs?err=reason_required&version=${encodeURIComponent(version)}`
    );
  }
  if (reason.length > 500) {
    redirect("/admin/packs?err=reason_too_long");
  }

  const db = getDb();
  if (!db) {
    redirect("/admin/packs?err=db_unconfigured");
  }

  const versionRow = await db
    .select({
      versionId: packVersions.id,
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
    redirect("/admin/packs?err=not_found");
  }

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
  const memberRole = memberRows[0]?.role;
  if (memberRole !== "owner") {
    redirect("/admin/packs?err=forbidden");
  }

  const nextStatus = status === "active" ? "published" : "quarantined";
  await db
    .update(packVersions)
    .set({ status: nextStatus as "published" | "quarantined" })
    .where(eq(packVersions.id, row.versionId));

  await appendAuditEvent({
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
      reason: reason || null,
    },
  });

  redirect(`/admin/packs?ok=1&version=${encodeURIComponent(version)}`);
}

async function signInAction(): Promise<void> {
  "use server";
  await signIn("github");
}

export default async function AdminPacksPage({
  searchParams,
}: PageProps) {
  const session = await auth();
  const sp = await searchParams;

  if (!session?.user?.id) {
    return (
      <div className="container-page space-y-6">
        <h1 className="h1">Admin · Pack status</h1>
        <p className="text-ink-600">
          Sign in to manage status of packs you own.
        </p>
        <form action={signInAction}>
          <button type="submit" className="btn-primary">
            Sign in with GitHub
          </button>
        </form>
      </div>
    );
  }

  const db = getDb();
  if (!db) {
    return (
      <div className="container-page space-y-4">
        <h1 className="h1">Admin · Pack status</h1>
        <div className="card border-amber-300 bg-amber-50 text-amber-900">
          <p>
            The registry is running in JSON-fallback mode (no{" "}
            <code className="font-mono">DATABASE_URL</code>). Admin actions are
            available once the registry is wired to Postgres. See{" "}
            <Link href="/docs/registry" className="underline">
              docs/registry
            </Link>{" "}
            for the bring-up.
          </p>
        </div>
      </div>
    );
  }

  const rows = await loadOwnedVersions(session.user.id);

  return (
    <div className="container-page space-y-6">
      <header>
        <h1 className="h1">Admin · Pack status</h1>
        <p className="mt-2 max-w-2xl text-ink-600">
          You can quarantine versions of packs you own. A quarantined version is
          refused by{" "}
          <code className="font-mono">agentpack install</code>, returns HTTP
          451 on the read API, and is replaced with a red banner on the pack
          detail page in place of the install command. Every status change
          writes a row to{" "}
          <code className="font-mono">audit_events</code> with your user id.
        </p>
      </header>

      {sp.ok && (
        <div
          className="card border-green-300 bg-green-50 text-green-900"
          role="status"
        >
          Status updated for version{" "}
          <code className="font-mono">{sp.version}</code>.
        </div>
      )}
      {sp.err && (
        <div
          className="card border-red-300 bg-red-50 text-red-900"
          role="alert"
        >
          Error:{" "}
          <code className="font-mono">{sp.err}</code>
          {sp.version && (
            <>
              {" "}for version <code className="font-mono">{sp.version}</code>
            </>
          )}
          .
        </div>
      )}

      {rows.length === 0 ? (
        <div className="card">
          <p className="text-ink-600">
            You don&apos;t own any packs yet, or none have been published. Once
            you publish a pack with{" "}
            <code className="font-mono">agentpack publish</code>, its versions
            will appear here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-ink-200 text-ink-500">
              <tr>
                <th className="py-2 pr-4">Pack</th>
                <th className="py-2 pr-4">Version</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Published</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.versionId}
                  className="border-b border-ink-100 align-top"
                >
                  <td className="py-3 pr-4">
                    <Link
                      href={`/packs/${row.publisherSlug}/${row.packSlug}`}
                      className="text-ink-900 underline-offset-2 hover:underline"
                    >
                      {row.publisherSlug}/{row.packSlug}
                    </Link>
                  </td>
                  <td className="py-3 pr-4 font-mono">{row.version}</td>
                  <td className="py-3 pr-4">
                    <StatusPill status={row.status} />
                  </td>
                  <td className="py-3 pr-4 text-ink-500">
                    {row.publishedAt.toISOString().slice(0, 10)}
                  </td>
                  <td className="py-3">
                    <form
                      action={setStatusAction}
                      className="flex flex-wrap items-start gap-2"
                    >
                      <input
                        type="hidden"
                        name="publisher"
                        value={row.publisherSlug}
                      />
                      <input
                        type="hidden"
                        name="pack"
                        value={row.packSlug}
                      />
                      <input
                        type="hidden"
                        name="version"
                        value={row.version}
                      />
                      {row.status === "quarantined" ? (
                        <>
                          <input
                            type="hidden"
                            name="status"
                            value="active"
                          />
                          <button
                            type="submit"
                            className="rounded-sm border border-ink-300 px-3 py-1 text-sm hover:bg-ink-50"
                          >
                            Unquarantine
                          </button>
                        </>
                      ) : (
                        <>
                          <input
                            type="hidden"
                            name="status"
                            value="quarantined"
                          />
                          <input
                            type="text"
                            name="reason"
                            required
                            maxLength={500}
                            placeholder="Reason (required, max 500 chars)"
                            className="w-64 rounded-sm border border-ink-300 px-2 py-1 text-sm"
                          />
                          <button
                            type="submit"
                            className="rounded-sm border border-red-300 bg-red-50 px-3 py-1 text-sm text-red-900 hover:bg-red-100"
                          >
                            Quarantine
                          </button>
                        </>
                      )}
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  if (status === "quarantined") {
    return (
      <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">
        Quarantined
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-900">
      {status}
    </span>
  );
}
