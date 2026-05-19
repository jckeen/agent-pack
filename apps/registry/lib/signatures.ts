/**
 * Pack-version signature lookup helpers for the UI + read APIs.
 *
 * Reads from `pack_signatures` joined to `pack_versions` → `packs` →
 * `publishers`. Returns null if the version is unsigned or the DB isn't
 * configured (registry boots in JSON-fallback mode without DATABASE_URL).
 */

import { and, desc, eq } from "drizzle-orm";

import {
  getDb,
  packSignatures,
  packVersions,
  packs,
  publishers,
} from "@/lib/db";

export interface UISignatureInfo {
  san: string;
  issuer: string;
  rekorLogUrl: string;
  signedAt: string;
}

/**
 * Return the most recent signature for the given pack version, or null if
 * unsigned / unconfigured. Used by the pack detail page's SignatureBadge.
 */
export async function getLatestSignatureForPack(
  publisher: string,
  pack: string,
  version: string
): Promise<UISignatureInfo | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const row = await db
      .select({
        san: packSignatures.signerSan,
        issuer: packSignatures.signerIssuer,
        rekorLogUrl: packSignatures.rekorLogUrl,
        signedAt: packSignatures.signedAt,
      })
      .from(packSignatures)
      .innerJoin(
        packVersions,
        eq(packSignatures.packVersionId, packVersions.id)
      )
      .innerJoin(packs, eq(packVersions.packId, packs.id))
      .innerJoin(publishers, eq(packs.publisherId, publishers.id))
      .where(
        and(
          eq(publishers.slug, publisher),
          eq(packs.slug, pack),
          eq(packVersions.version, version)
        )
      )
      .orderBy(desc(packSignatures.signedAt))
      .limit(1);
    if (!row[0]) return null;
    return {
      san: row[0].san,
      issuer: row[0].issuer,
      rekorLogUrl: row[0].rekorLogUrl,
      signedAt: row[0].signedAt.toISOString(),
    };
  } catch {
    return null;
  }
}
