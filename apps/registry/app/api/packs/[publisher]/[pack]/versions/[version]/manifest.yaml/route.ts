import { and, eq } from "drizzle-orm";

import { getDb, packVersions, packs, publishers } from "@/lib/db";
import { streamObject, R2NotConfiguredError } from "@/lib/r2";

export async function GET(
  _req: Request,
  {
    params,
  }: { params: Promise<{ publisher: string; pack: string; version: string }> }
): Promise<Response> {
  const { publisher, pack, version } = await params;
  const db = getDb();
  if (!db) return new Response("not configured", { status: 503 });

  const row = await db
    .select({
      manifestR2Key: packVersions.manifestR2Key,
      status: packVersions.status,
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
  if (!v) return new Response("not found", { status: 404 });
  if (v.status === "quarantined") {
    return new Response(JSON.stringify({ error: "quarantined" }), {
      status: 451,
      headers: { "content-type": "application/json" },
    });
  }
  if (v.status === "blocked") {
    return new Response(JSON.stringify({ error: "blocked" }), {
      status: 451,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const { stream } = await streamObject(v.manifestR2Key);
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-yaml",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    if (err instanceof R2NotConfiguredError) {
      return new Response("r2 not configured", { status: 503 });
    }
    throw err;
  }
}
