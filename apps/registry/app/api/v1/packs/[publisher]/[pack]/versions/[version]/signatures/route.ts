import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import {
  getDb,
  packSignatures,
  packVersions,
  packs,
  publishers,
} from "@/lib/db";

/**
 * GET /api/v1/packs/<publisher>/<pack>/versions/<version>/signatures
 *
 * Returns every signature attached to this version, newest first. Empty
 * `signatures: []` means unsigned. Used by `agentpack verify --sig` and
 * by the pack detail UI's "Signed by" badge resolution.
 */
export async function GET(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ publisher: string; pack: string; version: string }>;
  }
): Promise<Response> {
  const { publisher, pack, version } = await params;

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "db_unconfigured" }, { status: 503 });
  }

  const pubRow = await db
    .select()
    .from(publishers)
    .where(eq(publishers.slug, publisher))
    .limit(1);
  if (!pubRow[0]) {
    return NextResponse.json({ error: "publisher_not_found" }, { status: 404 });
  }
  const packRow = await db
    .select()
    .from(packs)
    .where(and(eq(packs.publisherId, pubRow[0].id), eq(packs.slug, pack)))
    .limit(1);
  if (!packRow[0]) {
    return NextResponse.json({ error: "pack_not_found" }, { status: 404 });
  }
  const versionRow = await db
    .select()
    .from(packVersions)
    .where(
      and(
        eq(packVersions.packId, packRow[0].id),
        eq(packVersions.version, version)
      )
    )
    .limit(1);
  if (!versionRow[0]) {
    return NextResponse.json({ error: "version_not_found" }, { status: 404 });
  }

  const sigs = await db
    .select()
    .from(packSignatures)
    .where(eq(packSignatures.packVersionId, versionRow[0].id))
    .orderBy(desc(packSignatures.signedAt));

  return NextResponse.json({
    publisher,
    pack,
    version,
    manifestSha256: versionRow[0].manifestSha256,
    signatures: sigs.map((s) => ({
      bundleB64: s.bundleB64,
      manifestChecksum: s.manifestSha256,
      envelopeVersion: s.envelopeVersion,
      // #35: serve the v2 release descriptor so `agentpack install`/`verify`
      // can check downloaded bytes against the SIGNED digest set. Omitted when
      // null (legacy v1, manifest-only signature).
      ...(s.releaseDescriptor ? { releaseDescriptor: s.releaseDescriptor } : {}),
      metadata: {
        identity: {
          san: s.signerSan,
          issuer: s.signerIssuer,
          // notBefore/notAfter live in the bundle's cert; surface "" here.
          // Callers that need them parse the bundle.
          notBefore: "",
          notAfter: "",
        },
        rekorLogIndex: s.rekorLogIndex,
        rekorLogId: s.rekorLogId,
        rekorLogUrl: s.rekorLogUrl,
        signedAt: s.signedAt.toISOString(),
      },
    })),
  });
}
