import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import {
  getDb,
  packFiles,
  packVersions,
  packs,
  publishers,
} from "@/lib/db";

export async function GET(
  _req: Request,
  {
    params,
  }: { params: Promise<{ publisher: string; pack: string; version: string }> }
): Promise<Response> {
  const { publisher, pack, version } = await params;
  const db = getDb();
  if (!db) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const row = await db
    .select({
      versionId: packVersions.id,
      version: packVersions.version,
      status: packVersions.status,
      manifestSha256: packVersions.manifestSha256,
      publishedAt: packVersions.publishedAt,
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
  const v = row[0];
  if (!v) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const files = await db
    .select()
    .from(packFiles)
    .where(eq(packFiles.packVersionId, v.versionId));

  return NextResponse.json({
    publisher,
    pack,
    version: v.version,
    status: v.status,
    manifestSha256: v.manifestSha256,
    publishedAt: v.publishedAt?.toISOString() ?? "",
    files: files.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      bytes: f.bytes,
      ...(f.atomId ? { atomId: f.atomId } : {}),
    })),
  });
}
