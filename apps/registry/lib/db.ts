/**
 * Registry-app DB client. Imports the canonical Drizzle schema from
 * `@agentpack/db` and exposes a memoized `getDb()` that the API routes use.
 *
 * Returns `null` when `DATABASE_URL` is unset so the seed.ts fallback works
 * (ISC-223). The graceful cascade is what lets `pnpm dev` boot without any
 * Postgres / R2 / GitHub OAuth config for local browsing of seed packs.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  apiTokens,
  accounts,
  atoms,
  auditEvents,
  compatibilities,
  packFiles,
  packSignatures,
  packVersions,
  packs,
  publisherMembers,
  publishers,
  publishes,
  reviews,
  sessions,
  users,
  verificationTokens,
} from "@agentpack/db";

export {
  apiTokens,
  accounts,
  atoms,
  auditEvents,
  compatibilities,
  packFiles,
  packSignatures,
  packVersions,
  packs,
  publisherMembers,
  publishers,
  publishes,
  reviews,
  sessions,
  users,
  verificationTokens,
};

export const schema = {
  users,
  publishers,
  publisherMembers,
  packs,
  packVersions,
  packSignatures,
  atoms,
  packFiles,
  compatibilities,
  apiTokens,
  publishes,
  reviews,
  auditEvents,
  accounts,
  sessions,
  verificationTokens,
};

export type Schema = typeof schema;
export type Database = ReturnType<typeof drizzle<Schema>>;

let _db: Database | null = null;
let _dbInitTried = false;

export function getDb(): Database | null {
  if (_dbInitTried) return _db;
  _dbInitTried = true;
  const url = process.env["DATABASE_URL"];
  if (!url) {
    _db = null;
    return null;
  }
  try {
    const client = postgres(url, {
      max: 10,
      idle_timeout: 30,
      prepare: false,
    });
    _db = drizzle(client, { schema });
    return _db;
  } catch (err) {
    console.error("[registry/db] failed to initialize Drizzle client:", (err as Error).message);
    _db = null;
    return null;
  }
}

/** Reset the singleton — for tests only. */
export function __resetDbForTests(): void {
  _db = null;
  _dbInitTried = false;
}
