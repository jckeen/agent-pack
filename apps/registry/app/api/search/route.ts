import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";

import { getDb, packs, publishers } from "@/lib/db";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) {
    return NextResponse.json({ results: [] });
  }
  const db = getDb();
  if (!db) return NextResponse.json({ results: [] });

  const rows = await db
    .select({
      publisher: publishers.slug,
      pack: packs.slug,
      description: packs.description,
      tags: packs.tags,
      rank: sql<number>`ts_rank_cd(${packs.search}, plainto_tsquery('english', ${q}))`,
    })
    .from(packs)
    .innerJoin(publishers, eq(publishers.id, packs.publisherId))
    .where(sql`${packs.search} @@ plainto_tsquery('english', ${q})`)
    .orderBy(sql`ts_rank_cd(${packs.search}, plainto_tsquery('english', ${q})) DESC`)
    .limit(50);

  return NextResponse.json({
    results: rows.map((r) => ({
      publisher: r.publisher,
      pack: r.pack,
      description: r.description,
      tags: r.tags ?? [],
      latestVersion: null,
      rank: r.rank,
    })),
  });
}
