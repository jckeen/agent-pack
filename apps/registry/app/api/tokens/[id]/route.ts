import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { apiTokens, getDb } from "@/lib/db";
import { evictBearerTokenBySha } from "@/lib/tokens";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "db_unconfigured" }, { status: 503 });
  }
  const { id } = await params;
  // Owner-only: scope the update to (id, userId) so a user can never revoke
  // someone else's token even if they guess the UUID.
  const updated = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, session.user.id)))
    .returning({ id: apiTokens.id, tokenSha256: apiTokens.tokenSha256 });
  if (updated.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Proactively drop the revoked token from this instance's positive cache so
  // it can't keep being accepted from a warm instance for the rest of the TTL.
  // Other instances see the revocation on their next miss, or immediately on
  // mutating paths via verifyBearer({ skipCache: true }).
  const sha = updated[0]?.tokenSha256;
  if (sha) evictBearerTokenBySha(sha);
  return new NextResponse(null, { status: 204 });
}
