import { and, eq } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  publisherMembers,
  publishers,
  type Publisher,
  type PublisherRole,
} from "../schema/index.js";

export async function getPublisherBySlug(
  db: Database,
  slug: string
): Promise<Publisher | null> {
  const rows = await db
    .select()
    .from(publishers)
    .where(eq(publishers.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

export async function userHasPublisherScope(
  db: Database,
  userId: string,
  publisherId: string,
  requiredRole?: PublisherRole
): Promise<boolean> {
  const rows = await db
    .select()
    .from(publisherMembers)
    .where(
      and(
        eq(publisherMembers.publisherId, publisherId),
        eq(publisherMembers.userId, userId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  if (requiredRole && row.role !== requiredRole && row.role !== "owner") {
    return false;
  }
  return true;
}

export async function listUserPublishers(
  db: Database,
  userId: string
): Promise<Array<{ publisher: Publisher; role: string }>> {
  const rows = await db
    .select({
      publisher: publishers,
      role: publisherMembers.role,
    })
    .from(publisherMembers)
    .innerJoin(publishers, eq(publishers.id, publisherMembers.publisherId))
    .where(eq(publisherMembers.userId, userId));
  return rows;
}
