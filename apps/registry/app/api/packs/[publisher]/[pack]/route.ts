import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { compareSemver } from "@agentpack/db";

import { getDb, packVersions, packs, publishers } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ publisher: string; pack: string }> },
): Promise<Response> {
  const { publisher, pack } = await params;
  const db = getDb();
  if (!db) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const row = await db
    .select({
      packId: packs.id,
      packSlug: packs.slug,
      description: packs.description,
      tags: packs.tags,
      publisherSlug: publishers.slug,
      latestVersionId: packs.latestVersionId,
    })
    .from(packs)
    .innerJoin(publishers, eq(publishers.id, packs.publisherId))
    .where(and(eq(publishers.slug, publisher), eq(packs.slug, pack)))
    .limit(1);
  const pk = row[0];
  if (!pk) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const versions = await db
    .select({
      version: packVersions.version,
      publishedAt: packVersions.publishedAt,
      status: packVersions.status,
    })
    .from(packVersions)
    .where(eq(packVersions.packId, pk.packId));

  return NextResponse.json({
    publisher: pk.publisherSlug,
    pack: pk.packSlug,
    description: pk.description,
    tags: pk.tags ?? [],
    versions: versions.map((v) => ({
      version: v.version,
      publishedAt: v.publishedAt?.toISOString() ?? "",
      status: v.status,
    })),
    latestVersion:
      versions
        .filter((v) => v.status === "published")
        // Semver order, not lexical — lexical sorts 0.10.0 < 0.9.0, picking the
        // wrong "latest". Reuse the canonical comparator. (backend-architect M4)
        .sort((a, b) => compareSemver(b.version, a.version))[0]?.version ?? null,
  });
}
