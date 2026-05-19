import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { approveUserCode } from "@/lib/cli-auth-store";
import {
  apiTokens,
  getDb,
  publisherMembers,
  publishers,
  users,
} from "@/lib/db";
import { generateToken } from "@/lib/tokens";
import { auth } from "@/lib/auth";

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as
    | { userCode?: string }
    | null;
  if (!body?.userCode) {
    return NextResponse.json({ error: "missing_user_code" }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "db_unconfigured" }, { status: 503 });
  }

  const { token, prefix, sha256 } = generateToken();

  await db.insert(apiTokens).values({
    userId: session.user.id,
    name: "workgraph-cli",
    tokenPrefix: prefix,
    tokenSha256: sha256,
    scopes: ["read:packs", "publish:packs"],
  });

  const u = await db
    .select()
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const memberships = await db
    .select({ slug: publishers.slug })
    .from(publisherMembers)
    .innerJoin(publishers, eq(publisherMembers.publisherId, publishers.id))
    .where(eq(publisherMembers.userId, session.user.id));

  const entry = approveUserCode(body.userCode, token, {
    userId: session.user.id,
    username: u[0]?.username ?? session.user.name ?? "user",
    publisherSlugs: memberships.map((m) => m.slug),
  });
  if (!entry) {
    return NextResponse.json({ error: "invalid_user_code" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
