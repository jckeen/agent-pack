import { NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { tokenScopeSchema } from "@agentpack/core";

import { auth } from "@/lib/auth";
import { apiTokens, getDb, publishers } from "@/lib/db";
import { generateToken } from "@/lib/tokens";

const createTokenSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(tokenScopeSchema).min(1).max(8),
  publisherSlug: z.string().min(1).max(64).optional(),
});

function unconfigured(): NextResponse {
  return NextResponse.json({ error: "db_unconfigured" }, { status: 503 });
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();
  const db = getDb();
  if (!db) return unconfigured();
  const rows = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.tokenPrefix,
      scopes: apiTokens.scopes,
      last_used_at: apiTokens.lastUsedAt,
      created_at: apiTokens.createdAt,
      revoked_at: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .where(
      and(eq(apiTokens.userId, session.user.id), isNull(apiTokens.revokedAt))
    )
    .orderBy(desc(apiTokens.createdAt));
  return NextResponse.json({ tokens: rows });
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();
  const db = getDb();
  if (!db) return unconfigured();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "validation", issues: [{ message: "invalid JSON" }] },
      { status: 422 }
    );
  }
  const parsed = createTokenSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation", issues: parsed.error.issues },
      { status: 422 }
    );
  }
  const { name, scopes, publisherSlug } = parsed.data;

  // If publisherSlug is supplied, the user must be a member.
  let publisherId: string | null = null;
  if (publisherSlug) {
    const pubRows = await db
      .select({ id: publishers.id })
      .from(publishers)
      .where(eq(publishers.slug, publisherSlug))
      .limit(1);
    const pub = pubRows[0];
    if (!pub) {
      return NextResponse.json(
        { error: "validation", issues: [{ message: "unknown publisher" }] },
        { status: 422 }
      );
    }
    publisherId = pub.id;
    if (!session.publisherSlugs?.includes(publisherSlug)) {
      return NextResponse.json(
        { error: "forbidden", reason: "not_publisher_member" },
        { status: 403 }
      );
    }
  }

  const { token, prefix, sha256 } = generateToken();
  const inserted = await db
    .insert(apiTokens)
    .values({
      userId: session.user.id,
      publisherId,
      name,
      tokenPrefix: prefix,
      tokenSha256: sha256,
      scopes,
    })
    .returning({ id: apiTokens.id });
  const row = inserted[0];
  if (!row) {
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  // Plaintext token returned ONCE. Caller must store it client-side.
  return NextResponse.json({
    id: row.id,
    token,
    prefix,
    scopes,
  });
}
