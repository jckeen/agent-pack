import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";

import { getDb, packs, publishers } from "@/lib/db";
import { clientKey, hit, tooManyRequests } from "@/lib/rate-limit";

export async function GET(req: Request): Promise<Response> {
  // Unauthenticated FTS runs a ts_rank_cd scan per request — throttle per IP.
  const rl = hit(clientKey(req, "search"), 30, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);
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
