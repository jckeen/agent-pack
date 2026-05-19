import { eq } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  publishes,
  type NewPublish,
  type PresignedFileEntry,
  type Publish,
} from "../schema/index.js";

export interface CreatePendingPublishInput {
  publisherSlug: string;
  packSlug: string;
  version: string;
  createdBy: string;
  expiresAt: Date;
  presignedFiles: PresignedFileEntry[];
}

export async function createPendingPublish(
  db: Database,
  input: CreatePendingPublishInput
): Promise<Publish> {
  const row: NewPublish = {
    publisherSlug: input.publisherSlug,
    packSlug: input.packSlug,
    version: input.version,
    status: "pending",
    expiresAt: input.expiresAt,
    createdBy: input.createdBy,
    presignedFiles: input.presignedFiles,
  };
  const inserted = await db.insert(publishes).values(row).returning();
  if (!inserted[0]) {
    throw new Error("createPendingPublish: insert returned no row");
  }
  return inserted[0];
}

export async function getPendingPublish(
  db: Database,
  publishId: string
): Promise<Publish | null> {
  const rows = await db
    .select()
    .from(publishes)
    .where(eq(publishes.id, publishId))
    .limit(1);
  return rows[0] ?? null;
}

export async function markPublishCompleted(
  db: Database,
  publishId: string,
  packId: string
): Promise<void> {
  await db
    .update(publishes)
    .set({ status: "completed", packId })
    .where(eq(publishes.id, publishId));
}

export async function abortPublish(
  db: Database,
  publishId: string
): Promise<void> {
  await db
    .update(publishes)
    .set({ status: "aborted" })
    .where(eq(publishes.id, publishId));
}
