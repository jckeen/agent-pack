import { and, eq } from "drizzle-orm";

import {
  getDb,
  packFiles,
  packVersions,
  packs,
  publishers,
} from "@/lib/db";
import { streamObject, R2NotConfiguredError } from "@/lib/r2";

export async function GET(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{
      publisher: string;
      pack: string;
      version: string;
      atomId: string;
      path: string[];
    }>;
  }
): Promise<Response> {
  const { publisher, pack, version, atomId, path: pathSegments } = await params;
  const filePath = pathSegments.join("/");
  const db = getDb();
  if (!db) return new Response("not configured", { status: 503 });

  const row = await db
    .select({
      r2Key: packFiles.r2Key,
      sha256: packFiles.sha256,
      bytes: packFiles.bytes,
      status: packVersions.status,
    })
    .from(packFiles)
    .innerJoin(packVersions, eq(packVersions.id, packFiles.packVersionId))
    .innerJoin(packs, eq(packs.id, packVersions.packId))
    .innerJoin(publishers, eq(publishers.id, packs.publisherId))
    .where(
      and(
        eq(publishers.slug, publisher),
        eq(packs.slug, pack),
        eq(packVersions.version, version),
        eq(packFiles.atomId, atomId),
        eq(packFiles.path, filePath)
      )
    )
    .limit(1);
  const f = row[0];
  if (!f) return new Response("not found", { status: 404 });
  if (f.status === "quarantined" || f.status === "blocked") {
    return new Response(JSON.stringify({ error: f.status }), {
      status: 451,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const { stream } = await streamObject(f.r2Key);
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
        "x-amz-meta-sha256": f.sha256,
        "content-length": String(f.bytes),
      },
    });
  } catch (err) {
    if (err instanceof R2NotConfiguredError) {
      return new Response("r2 not configured", { status: 503 });
    }
    throw err;
  }
}
