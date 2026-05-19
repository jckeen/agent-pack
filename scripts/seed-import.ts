/**
 * Idempotent seed migration.
 *
 * Reads `seed/seed-packs.json` and INSERTs rows that don't exist into the
 * registry DB. Skips rows that do. Safe to re-run after partial failures.
 *
 * Run with:
 *   DATABASE_URL='postgres://...' pnpm seed:import
 *
 * See `docs/registry.md` § Seed migration for rationale.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { and, eq } from "drizzle-orm";

import {
  getDb,
  packs,
  packVersions,
  publishers,
  users,
} from "@workgraph/db";

interface SeedPack {
  id: string;
  name: string;
  description: string;
  publisher: string;
  version: string;
  tags?: string[];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const db = getDb(url);
  if (!db) {
    console.error("getDb() returned null — check DATABASE_URL");
    process.exit(1);
  }

  const seedPath = path.join(
    process.cwd(),
    "seed",
    "seed-packs.json"
  );
  const raw = await fs.readFile(seedPath, "utf-8");
  const seedPacks = JSON.parse(raw) as SeedPack[];

  // Ensure a "seed" placeholder user owns these rows.
  let seedUserRow = await db
    .select()
    .from(users)
    .where(eq(users.githubId, "seed-bootstrap"))
    .limit(1);
  if (seedUserRow.length === 0) {
    const inserted = await db
      .insert(users)
      .values({
        githubId: "seed-bootstrap",
        username: "seed",
      })
      .returning();
    seedUserRow = inserted;
  }
  const seedUser = seedUserRow[0];
  if (!seedUser) {
    console.error("Failed to create seed user");
    process.exit(1);
  }

  let inserted = 0;
  let skipped = 0;

  for (const pack of seedPacks) {
    const [publisherSlug, packSlug] = pack.id.split(".");
    if (!publisherSlug || !packSlug) {
      console.warn(`skipping invalid pack id: ${pack.id}`);
      continue;
    }

    // Ensure publisher.
    let pubRow = await db
      .select()
      .from(publishers)
      .where(eq(publishers.slug, publisherSlug))
      .limit(1);
    if (pubRow.length === 0) {
      pubRow = await db
        .insert(publishers)
        .values({
          slug: publisherSlug,
          displayName: pack.publisher ?? publisherSlug,
        })
        .returning();
    }
    const pub = pubRow[0];
    if (!pub) continue;

    // Ensure pack.
    let pkRow = await db
      .select()
      .from(packs)
      .where(and(eq(packs.publisherId, pub.id), eq(packs.slug, packSlug)))
      .limit(1);
    if (pkRow.length === 0) {
      pkRow = await db
        .insert(packs)
        .values({
          publisherId: pub.id,
          slug: packSlug,
          name: pack.name,
          description: pack.description,
          tags: pack.tags ?? [],
        })
        .returning();
    }
    const pk = pkRow[0];
    if (!pk) continue;

    // Ensure pack version.
    const existingVersion = await db
      .select()
      .from(packVersions)
      .where(
        and(
          eq(packVersions.packId, pk.id),
          eq(packVersions.version, pack.version)
        )
      )
      .limit(1);
    if (existingVersion.length > 0) {
      skipped += 1;
      continue;
    }
    await db.insert(packVersions).values({
      packId: pk.id,
      version: pack.version,
      status: "published",
      manifestSha256: "0".repeat(64),
      manifestR2Key: `${publisherSlug}/${packSlug}/${pack.version}/manifest.yaml`,
      publishedBy: seedUser.id,
    });
    inserted += 1;
  }

  console.log(`seed-import: ${inserted} inserted, ${skipped} skipped`);
  process.exit(0);
}

main().catch((err) => {
  console.error("seed-import failed:", err);
  process.exit(1);
});
