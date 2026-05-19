import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import type { PublishFinalizeResponse } from "@agentpack/core";
import { signing } from "@agentpack/core";

import {
  atoms,
  compatibilities,
  getDb,
  packFiles,
  packSignatures,
  packVersions,
  packs,
  publishers,
  publishes,
} from "@/lib/db";
import { headObject, R2NotConfiguredError } from "@/lib/r2";
import { requireScope, verifyBearer } from "@/lib/tokens";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ publishId: string }> }
): Promise<Response> {
  const verified = await verifyBearer(req);
  if (!verified) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { publishId } = await params;
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "db_unconfigured" }, { status: 503 });
  }

  const pubRow = await db
    .select()
    .from(publishes)
    .where(eq(publishes.id, publishId))
    .limit(1);
  const pub = pubRow[0];
  if (!pub) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Security-reviewer C1 fix — only the token that INITIATED this publish
  // can finalize it, AND that token must still hold publish scope on the
  // target publisher. The original code accepted any authenticated bearer
  // token, which let a logged-in attacker hijack a pending publishId and
  // even silently auto-create publisher namespaces with zero members.
  if (pub.createdBy !== verified.userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    requireScope(verified, "publish:packs", pub.publisherSlug);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  if (pub.status !== "pending") {
    return NextResponse.json(
      { error: "already_finalized" },
      { status: 409 }
    );
  }
  if (pub.expiresAt < new Date()) {
    return NextResponse.json(
      { error: "publish_expired", publishId },
      { status: 410 }
    );
  }

  // Optional signature in the body. If present, parse + verify server-side
  // BEFORE inserting the version row so a bogus signature aborts the publish.
  let parsedSignature: signing.SignedManifest | null = null;
  try {
    const bodyText = await req.text();
    if (bodyText.length > 0) {
      const body = JSON.parse(bodyText) as { signature?: unknown };
      if (body.signature !== undefined && body.signature !== null) {
        const parsed = signing.signedManifestSchema.safeParse(body.signature);
        if (!parsed.success) {
          return NextResponse.json(
            { error: "invalid_signature_envelope", issues: parsed.error.issues },
            { status: 422 }
          );
        }
        parsedSignature = parsed.data;
        // Cryptographically verify against the manifest hash the publisher
        // declared at init time. If they disagree, refuse before persistence.
        const manifestFileForSig = pub.presignedFiles.find(
          (f) => f.path === "AGENTPACK.yaml"
        );
        const expectedChecksum = manifestFileForSig?.sha256 ?? "";
        const result = await signing.verifyManifestSignature({
          manifestChecksum: expectedChecksum,
          signed: parsedSignature,
        });
        if (!result.valid) {
          return NextResponse.json(
            {
              error: "signature_invalid",
              reason: result.reason,
              detail: result.detail,
            },
            { status: 422 }
          );
        }
      }
    }
  } catch {
    // Bad JSON in body is fine — finalize is allowed to be called with no
    // body. We only validate JSON that successfully parses.
  }

  // Verify each file's size via R2 HEAD.
  const mismatched: Array<{ path: string; expected: number; got: number | "missing" }> = [];
  try {
    for (const file of pub.presignedFiles) {
      const head = await headObject(file.r2Key);
      if (!head) {
        mismatched.push({ path: file.path, expected: file.bytes, got: "missing" });
      } else if (file.bytes > 0 && head.contentLength !== file.bytes) {
        mismatched.push({
          path: file.path,
          expected: file.bytes,
          got: head.contentLength,
        });
      }
    }
  } catch (err) {
    if (err instanceof R2NotConfiguredError) {
      return NextResponse.json({ error: "r2_unconfigured" }, { status: 503 });
    }
    throw err;
  }

  if (mismatched.length > 0) {
    return NextResponse.json(
      { error: "size_mismatch", mismatched },
      { status: 422 }
    );
  }

  // Resolve publisher. We require an existing row — auto-create was a
  // namespace-squat amplifier (security-reviewer C1, second leg). Membership
  // is enforced via requireScope() above; the only way to get here is to
  // already be a recognized member of pub.publisherSlug, which itself
  // implies the publishers row exists.
  const existingPub = await db
    .select()
    .from(publishers)
    .where(eq(publishers.slug, pub.publisherSlug))
    .limit(1);
  if (!existingPub[0]) {
    return NextResponse.json(
      { error: "publisher_not_found", publisher: pub.publisherSlug },
      { status: 404 }
    );
  }
  const pubsId = existingPub[0].id;

  // Find or create pack.
  let pkId: string;
  const existingPk = await db
    .select()
    .from(packs)
    .where(and(eq(packs.publisherId, pubsId), eq(packs.slug, pub.packSlug)))
    .limit(1);
  if (existingPk[0]) {
    pkId = existingPk[0].id;
  } else {
    const inserted = await db
      .insert(packs)
      .values({
        publisherId: pubsId,
        slug: pub.packSlug,
        name: pub.packSlug,
        description: "",
        tags: [],
      })
      .returning({ id: packs.id });
    if (!inserted[0]) {
      return NextResponse.json({ error: "pack_insert_failed" }, { status: 500 });
    }
    pkId = inserted[0].id;
  }

  // Insert pack version row.
  const manifestFile = pub.presignedFiles.find((f) => f.path === "AGENTPACK.yaml");
  const insertedVersion = await db
    .insert(packVersions)
    .values({
      packId: pkId,
      version: pub.version,
      status: "published",
      manifestSha256: manifestFile?.sha256 ?? "",
      manifestR2Key: manifestFile?.r2Key ?? "",
      publishedBy: verified.userId,
    })
    .returning({ id: packVersions.id });
  const versionId = insertedVersion[0]?.id;
  if (!versionId) {
    return NextResponse.json({ error: "version_insert_failed" }, { status: 500 });
  }

  // Insert pack_files.
  if (pub.presignedFiles.length > 0) {
    await db.insert(packFiles).values(
      pub.presignedFiles.map((f) => ({
        packVersionId: versionId,
        atomId: f.atomId ?? null,
        path: f.path,
        sha256: f.sha256,
        bytes: f.bytes,
        r2Key: f.r2Key,
      }))
    );
  }

  // Insert signature row if the publisher signed. This is the canonical
  // storage location — the registry will surface it via /signatures + on
  // the pack detail page and CLI `verify --sig` will fetch it from here.
  if (parsedSignature) {
    await db.insert(packSignatures).values({
      packVersionId: versionId,
      bundleB64: parsedSignature.bundleB64,
      signerSan: parsedSignature.metadata.identity.san,
      signerIssuer: parsedSignature.metadata.identity.issuer,
      rekorLogIndex: parsedSignature.metadata.rekorLogIndex,
      rekorLogId: parsedSignature.metadata.rekorLogId,
      rekorLogUrl: parsedSignature.metadata.rekorLogUrl,
      manifestSha256: parsedSignature.manifestChecksum,
      envelopeVersion: parsedSignature.envelopeVersion,
      signedAt: new Date(parsedSignature.metadata.signedAt),
    });
  }

  // Insert atoms placeholder rows from the presigned-files atom IDs. Real atom
  // metadata (type, risk_level) lives in the AGENTPACK.yaml — a background
  // worker can backfill richer data later. v0.3 captures the IDs only.
  const atomIds = [...new Set(pub.presignedFiles.flatMap((f) => (f.atomId ? [f.atomId] : [])))];
  if (atomIds.length > 0) {
    await db.insert(atoms).values(
      atomIds.map((atomId) => ({
        packVersionId: versionId,
        atomId,
        type: "unknown",
        riskLevel: "low",
        metadata: {},
      }))
    );
  }

  // Mark publish completed.
  await db
    .update(publishes)
    .set({ status: "completed", packId: pkId })
    .where(eq(publishes.id, publishId));

  // Update latest_version_id (simple: latest by published_at wins).
  await db
    .update(packs)
    .set({ latestVersionId: versionId })
    .where(eq(packs.id, pkId));

  // No compatibilities in this MVP — populate when the manifest YAML is
  // parsed server-side by a background worker.
  void compatibilities;

  const baseUrl = process.env["NEXT_PUBLIC_REGISTRY_URL"] ?? "https://registry.agentpack.dev";
  const response: PublishFinalizeResponse = {
    packId: pkId,
    versionId,
    url: `${baseUrl}/packs/${pub.publisherSlug}/${pub.packSlug}/${pub.version}`,
  };
  return NextResponse.json(response);
}
