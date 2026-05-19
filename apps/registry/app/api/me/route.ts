import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { getDb, publisherMembers, publishers, users } from "@/lib/db";
import { verifyBearer } from "@/lib/tokens";

export async function GET(req: Request): Promise<Response> {
  const verified = await verifyBearer(req);
  if (!verified) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "db_unconfigured" }, { status: 503 });
  }
  const u = await db.select().from(users).where(eq(users.id, verified.userId)).limit(1);
  const user = u[0];
  if (!user) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }
  const memberships = await db
    .select({ slug: publishers.slug })
    .from(publisherMembers)
    .innerJoin(publishers, eq(publisherMembers.publisherId, publishers.id))
    .where(eq(publisherMembers.userId, verified.userId));
  return NextResponse.json({
    id: user.id,
    username: user.username,
    publisherSlugs: memberships.map((m) => m.slug),
  });
}
