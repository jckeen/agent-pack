import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { getDb, packs, publishers } from "@/lib/db";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit")) || 50, 1),
    100
  );
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

  return NextResponse.json({
    packs: rows.map((r) => ({
      publisher: r.publisher,
      pack: r.slug,
      description: r.description,
      tags: r.tags ?? [],
      versions: [],
      latestVersion: null,
    })),
    total: rows.length,
  });
}
