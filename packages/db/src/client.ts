/**
 * Database client factory stub. W1 replaces with concrete Drizzle client.
 *
 * Contract: `getDb(url)` returns a Drizzle client. If `url` is undefined,
 * `process.env.DATABASE_URL` is used. If neither is set, returns `null` so
 * callers can fall back gracefully (per ISC-223).
 */

export type Database = unknown;

export function getDb(_url?: string): Database | null {
  return null;
}
