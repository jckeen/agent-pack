/**
 * Drizzle schema barrel. Table objects exported from here are the source of
 * truth for both `apps/registry` API routes and `scripts/seed-import.ts`.
 *
 * `TABLE_NAMES` (preserved from the protocol-commit stub) is the pinned set
 * of Postgres table identifiers per `Plans/PROTOCOL.md` § 4.
 */

export const TABLE_NAMES = {
  users: "users",
  publishers: "publishers",
  publisherMembers: "publisher_members",
  packs: "packs",
  packVersions: "pack_versions",
  packSignatures: "pack_signatures",
  atoms: "atoms",
  packFiles: "pack_files",
  compatibilities: "compatibilities",
  apiTokens: "api_tokens",
  publishes: "publishes",
  reviews: "reviews",
  auditEvents: "audit_events",
  accounts: "accounts",
  sessions: "sessions",
  verificationTokens: "verification_tokens",
} as const;

export type TableName = (typeof TABLE_NAMES)[keyof typeof TABLE_NAMES];

export { users, type User, type NewUser } from "./users.js";
export {
  publishers,
  publisherMembers,
  type Publisher,
  type NewPublisher,
  type PublisherMember,
  type NewPublisherMember,
  type PublisherRole,
} from "./publishers.js";
export { packs, tsvector, type Pack, type NewPack } from "./packs.js";
export {
  packVersions,
  versionStatusEnum,
  VERSION_STATUS,
  type PackVersion,
  type NewPackVersion,
  type VersionStatusEnum,
} from "./packVersions.js";
export {
  packSignatures,
  type PackSignature,
  type PackSignatureInsert,
} from "./packSignatures.js";
export { atoms, type AtomRow, type NewAtomRow } from "./atoms.js";
export { packFiles, type PackFile, type NewPackFile } from "./packFiles.js";
export {
  compatibilities,
  type Compatibility,
  type NewCompatibility,
} from "./compatibilities.js";
export {
  apiTokens,
  type ApiToken,
  type NewApiToken,
} from "./apiTokens.js";
export {
  publishes,
  PUBLISH_STATUS,
  type Publish,
  type NewPublish,
  type PublishStatus,
  type PresignedFileEntry,
} from "./publishes.js";
export { reviews, type Review, type NewReview } from "./reviews.js";
export {
  auditEvents,
  type AuditEvent,
  type NewAuditEvent,
} from "./auditEvents.js";
export {
  accounts,
  sessions,
  verificationTokens,
  type Account,
  type Session,
  type VerificationToken,
} from "./authjs.js";
