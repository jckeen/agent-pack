/**
 * Pack-side query helpers.
 *
 * Functions take a Drizzle `Database` as the first arg so callers can pass a
 * test DB or share a request-scoped client. All functions return null/empty
 * when the row(s) don't exist — callers map to 404 at the API boundary.
 */

import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  packs,
  packVersions,
  publishers,
  type Pack,
  type PackVersion,
  type Publisher,
} from "../schema/index.js";

export interface ListPacksOptions {
  limit?: number;
  offset?: number;
  tag?: string;
  search?: string;
}

export interface PackWithPublisher extends Pack {
  publisherSlug: string;
}

export async function listPacks(
  db: Database,
  opts: ListPacksOptions = {},
): Promise<{ packs: PackWithPublisher[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  const where = opts.tag
    ? sql`${opts.tag} = ANY(${packs.tags})`
    : opts.search
      ? sql`${packs.search} @@ plainto_tsquery('english', ${opts.search})`
      : sql`true`;

  const rows = await db
    .select({
      pack: packs,
      publisherSlug: publishers.slug,
    })
    .from(packs)
    .innerJoin(publishers, eq(publishers.id, packs.publisherId))
    .where(where)
    .limit(limit)
    .offset(offset)
    .orderBy(desc(packs.createdAt));

  const totalRow = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(packs)
    .where(where);

  return {
    packs: rows.map((r) => ({ ...r.pack, publisherSlug: r.publisherSlug })),
    total: totalRow[0]?.count ?? 0,
  };
}

export async function getPackBySlug(
  db: Database,
  publisherSlug: string,
  packSlug: string,
): Promise<{ pack: Pack; publisher: Publisher } | null> {
  const row = await db
    .select({ pack: packs, publisher: publishers })
    .from(packs)
    .innerJoin(publishers, eq(publishers.id, packs.publisherId))
    .where(and(eq(publishers.slug, publisherSlug), eq(packs.slug, packSlug)))
    .limit(1);
  if (row.length === 0 || !row[0]) return null;
  return { pack: row[0].pack, publisher: row[0].publisher };
}

export async function listPackVersions(
  db: Database,
  packId: string,
): Promise<PackVersion[]> {
  return db
    .select()
    .from(packVersions)
    .where(eq(packVersions.packId, packId))
    .orderBy(desc(packVersions.publishedAt));
}

export async function getLatestVersion(
  db: Database,
  packId: string,
): Promise<PackVersion | null> {
  const rows = await db
    .select()
    .from(packVersions)
    .where(and(eq(packVersions.packId, packId), eq(packVersions.status, "published")))
    .orderBy(desc(packVersions.publishedAt));
  // Pick highest semver from published rows (most recent wins on ties).
  const sorted = rows.slice().sort((a, b) => compareSemver(b.version, a.version));
  return sorted[0] ?? null;
}

export async function getVersion(
  db: Database,
  packId: string,
  version: string,
): Promise<PackVersion | null> {
  const row = await db
    .select()
    .from(packVersions)
    .where(and(eq(packVersions.packId, packId), eq(packVersions.version, version)))
    .limit(1);
  return row[0] ?? null;
}

export function compareSemver(a: string, b: string): number {
  const [ax = "0", bx = "0"] = [a, b];
  const re = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;
  const am = ax.match(re);
  const bm = bx.match(re);
  if (!am || !bm) return ax.localeCompare(bx);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(am[i]) - Number(bm[i]);
    if (diff !== 0) return diff;
  }
  // Pre-release: presence means lower precedence.
  if (am[4] && !bm[4]) return -1;
  if (!am[4] && bm[4]) return 1;
  return (am[4] ?? "").localeCompare(bm[4] ?? "");
}
