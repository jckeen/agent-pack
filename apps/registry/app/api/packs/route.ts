import { NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";

import { getDb, packs, publishers } from "@/lib/db";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const db = getDb();
  if (!db) {
    return NextResponse.json({ packs: [], total: 0 });
  }

  const rows = await db
    .select({
      publisher: publishers.slug,
      slug: packs.slug,
      description: packs.description,
      tags: packs.tags,
    })
    .from(packs)
    .innerJoin(publishers, eq(publishers.id, packs.publisherId))
    .limit(limit)
    .offset(offset);

  // Real total across ALL packs, not the page size — a client paginating off
  // `total` needs to know there's a next page (backend-architect MEDIUM #7).
  const totalRows = await db.select({ value: count() }).from(packs);
  const total = totalRows[0]?.value ?? 0;

  return NextResponse.json({
    packs: rows.map((r) => ({
      publisher: r.publisher,
      pack: r.slug,
      description: r.description,
      tags: r.tags ?? [],
      versions: [],
      latestVersion: null,
    })),
    total,
  });
}
