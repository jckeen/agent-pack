import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { approveUserCode } from "@/lib/cli-auth-store";
import { apiTokens, getDb, publisherMembers, publishers, users } from "@/lib/db";
import { generateToken } from "@/lib/tokens";
import { auth } from "@/lib/auth";
import { hit, tooManyRequests } from "@/lib/rate-limit";

export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Throttle approve attempts per user — a guessed userCode lets an attacker
  // bind their token to a victim's CLI session, so slow enumeration velocity.
  // Best-effort and per-instance on serverless (see lib/rate-limit.ts); the
  // userCode's own entropy + short TTL is the primary guard.
  const rl = hit(`approve:${session.user.id}`, 10, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);
  const body = (await req.json().catch(() => null)) as { userCode?: string } | null;
  if (!body?.userCode) {
    return NextResponse.json({ error: "missing_user_code" }, { status: 400 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "db_unconfigured" }, { status: 503 });
  }

  const { token, prefix, sha256 } = generateToken();

  const u = await db.select().from(users).where(eq(users.id, session.user.id)).limit(1);
  const memberships = await db
    .select({ slug: publishers.slug })
    .from(publisherMembers)
    .innerJoin(publishers, eq(publisherMembers.publisherId, publishers.id))
    .where(eq(publisherMembers.userId, session.user.id));

  // Bind the freshly-generated token to the pending device-code FIRST. A bad
  // (or guessed) userCode must NOT leave a live, never-delivered token behind:
  // minting before validating accumulated one orphan publish-capable credential
  // per failed approve. Only persist the token after the bind succeeds.
  // (backend-architect H2 / security-reviewer device-auth)
  const entry = approveUserCode(body.userCode, token, {
    userId: session.user.id,
    username: u[0]?.username ?? session.user.name ?? "user",
    publisherSlugs: memberships.map((m) => m.slug),
  });
  if (!entry) {
    return NextResponse.json({ error: "invalid_user_code" }, { status: 404 });
  }

  await db.insert(apiTokens).values({
    userId: session.user.id,
    name: "agentpack-cli",
    tokenPrefix: prefix,
    tokenSha256: sha256,
    scopes: ["read:packs", "publish:packs"],
  });

  return new Response(null, { status: 204 });
}
