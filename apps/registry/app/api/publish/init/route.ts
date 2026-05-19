import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { ZodError } from "zod";

import {
  publishInitRequestSchema,
  type PublishInitResponse,
} from "@workgraph/core";

import {
  getDb,
  packs,
  packVersions,
  publishes,
  publishers,
} from "@/lib/db";
import { presignPutUrl, R2NotConfiguredError } from "@/lib/r2";
import { requireScope, verifyBearer } from "@/lib/tokens";

export async function POST(req: Request): Promise<Response> {
  const verified = await verifyBearer(req);
  if (!verified) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  let parsed;
  try {
    parsed = publishInitRequestSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: "validation", issues: err.issues },
        { status: 422 }
      );
    }
    throw err;
  }

  try {
    requireScope(verified, "publish:packs", parsed.publisher);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "db_unconfigured" }, { status: 503 });
  }

  // Conflict check.
  const pubRow = await db
    .select()
    .from(publishers)
    .where(eq(publishers.slug, parsed.publisher))
    .limit(1);
  const pub = pubRow[0];
  if (pub) {
    const packRow = await db
      .select()
      .from(packs)
      .where(and(eq(packs.publisherId, pub.id), eq(packs.slug, parsed.pack)))
      .limit(1);
    const pk = packRow[0];
    if (pk) {
      const versionRow = await db
        .select()
        .from(packVersions)
        .where(
          and(
            eq(packVersions.packId, pk.id),
            eq(packVersions.version, parsed.version)
          )
        )
        .limit(1);
      if (versionRow.length > 0) {
        return NextResponse.json(
          {
            error: "version_exists",
            existing: {
              publishedAt: versionRow[0]?.publishedAt?.toISOString() ?? "",
            },
          },
          { status: 409 }
        );
      }
    }
  }

  // Presign each file. The manifest entry now carries its real byte count
  // (security-reviewer H2 fix — bytes: 0 was a checksum-skip footgun).
  let presignedUploads;
  try {
    presignedUploads = await Promise.all(
      [
        {
          path: "AGENTPACK.yaml",
          sha256: parsed.manifestSha256,
          bytes: parsed.manifestBytes,
        },
        ...parsed.files,
      ].map(async (f) => {
        const r2Key = `${parsed.publisher}/${parsed.pack}/${parsed.version}/${f.path}`;
        const presign = await presignPutUrl(r2Key, {
          sha256: f.sha256,
          bytes: f.bytes,
        });
        return {
          path: f.path,
          r2Key,
          sha256: f.sha256,
          bytes: f.bytes,
          atomId: "atomId" in f ? f.atomId : undefined,
          presignedUrl: presign.url,
          presignedHeaders: presign.headers,
        };
      })
    );
  } catch (err) {
    if (err instanceof R2NotConfiguredError) {
      return NextResponse.json({ error: "r2_unconfigured" }, { status: 503 });
    }
    throw err;
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const inserted = await db
    .insert(publishes)
    .values({
      publisherSlug: parsed.publisher,
      packSlug: parsed.pack,
      version: parsed.version,
      status: "pending",
      expiresAt,
      createdBy: verified.userId,
      presignedFiles: presignedUploads,
    })
    .returning({ id: publishes.id });

  const publishId = inserted[0]?.id;
  if (!publishId) {
    return NextResponse.json({ error: "publish_insert_failed" }, { status: 500 });
  }

  const response: PublishInitResponse = {
    publishId,
    expiresAt: expiresAt.toISOString(),
    presignedUploads: presignedUploads.map((p) => ({
      path: p.path,
      url: p.presignedUrl,
      headers: p.presignedHeaders,
    })),
  };
  return NextResponse.json(response);
}
