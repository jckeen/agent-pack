/**
 * Drizzle client factory.
 *
 * - `getDb(url?)` returns a Drizzle ORM client over the `postgres` driver.
 * - When `url` is undefined, reads `process.env.DATABASE_URL`.
 * - When neither set, returns `null` so callers can fall back gracefully
 *   (`apps/registry/lib/seed.ts` uses this to drop to JSON seed when no DB
 *   is configured — ISC-223).
 *
 * The client is memoized per URL so multiple `getDb()` calls share a
 * connection pool. The pool is small (max=10) by default — tune via
 * `DATABASE_POOL_MAX` env var.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema/index.js";

export type Database = PostgresJsDatabase<typeof schema>;

const pools = new Map<string, { db: Database; client: Sql }>();

export function getDb(url?: string): Database | null {
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) {
    return null;
  }

  const cached = pools.get(connectionString);
  if (cached) {
    return cached.db;
  }

  const max = Number.parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10);
  const client = postgres(connectionString, {
    max: Number.isFinite(max) ? max : 10,
    prepare: false,
  });
  const db = drizzle(client, { schema });
  pools.set(connectionString, { db, client });
  return db;
}

/**
 * Test-only helper. Closes all pooled clients. Call from `afterAll` hooks.
 */
export async function closeAllPools(): Promise<void> {
  const closing = Array.from(pools.values()).map((p) => p.client.end({ timeout: 1 }));
  pools.clear();
  await Promise.all(closing);
}
