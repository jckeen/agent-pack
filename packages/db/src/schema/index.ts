/**
 * Stub barrel for the Drizzle schema. The Foundation worktree (W1) replaces
 * this with concrete table definitions.
 *
 * Table names pinned by `Plans/PROTOCOL.md` § 4. Worktree agents MUST use
 * these exact names — they are part of the public contract that other
 * workstreams import.
 */

export const TABLE_NAMES = {
  users: "users",
  publishers: "publishers",
  publisherMembers: "publisher_members",
  packs: "packs",
  packVersions: "pack_versions",
  atoms: "atoms",
  packFiles: "pack_files",
  compatibilities: "compatibilities",
  apiTokens: "api_tokens",
  publishes: "publishes",
  reviews: "reviews",
  auditEvents: "audit_events",
  // NextAuth + Drizzle adapter tables
  accounts: "accounts",
  sessions: "sessions",
  verificationTokens: "verification_tokens",
} as const;

export type TableName = (typeof TABLE_NAMES)[keyof typeof TABLE_NAMES];
