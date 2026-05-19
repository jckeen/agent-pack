/**
 * Protocol module — wire shapes for the AgentPack registry (Phase 3) and
 * remote-install CLI (Phase 5).
 *
 * Source of truth: `Plans/PROTOCOL.md`. All worktree agents extending Phase 3+5
 * MUST import their shapes from here, not reinvent them.
 */

import { z } from "zod";

import {
  ATOM_TYPES,
  TARGET_PLATFORMS,
  PROFILE_NAMES,
  type ProfileName,
  type RiskLevel,
} from "../schema/types.js";

export { ExitCode, RegistryErrorName, errorNameToExitCode } from "./error-codes.js";
export type { ExitCodeName, ExitCodeValue } from "./error-codes.js";

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

/** Lowercase hex string, 64 chars (SHA-256). */
export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "sha256 must be lowercase hex, 64 chars");

/** Slug: `[a-z0-9][a-z0-9-]*[a-z0-9]`, 2-64 chars. */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "invalid slug");

/** Semver-ish: no leading 'v', allows pre-release/build tags. */
export const semverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "invalid semver"
  );

/** Project-relative POSIX path, no `..`, no leading slash. */
export const relativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.startsWith("/"), "must be project-relative")
  .refine((p) => !p.split("/").includes(".."), "must not contain '..'")
  .refine((p) => !/[\\]/.test(p), "must use POSIX separators");

export const platformTargetSchema = z.enum(
  TARGET_PLATFORMS as unknown as readonly [string, ...string[]]
);

export const atomTypeSchema = z.enum(
  ATOM_TYPES as unknown as readonly [string, ...string[]]
);

export const compatibilityStatusSchema = z.enum([
  "supported",
  "partial",
  "experimental",
  "unsupported",
]);

export const versionStatusSchema = z.enum([
  "published",
  "deprecated",
  "yanked",
  "quarantined",
  "blocked",
]);

export type VersionStatus = z.infer<typeof versionStatusSchema>;

export const profileNameSchema = z.union([
  z.enum(PROFILE_NAMES as unknown as readonly [string, ...string[]]),
  z.string().min(1),
]);

// ---------------------------------------------------------------------------
// Token scopes (Phase 3)
// ---------------------------------------------------------------------------

export const TOKEN_SCOPES = [
  "read:packs",
  "read:private",
  "publish:packs",
  "admin:registry",
] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const tokenScopeSchema = z.string().refine((s) => {
  if ((TOKEN_SCOPES as readonly string[]).includes(s)) return true;
  // Allow scoped variants: `publish:packs@<publisher>`, `read:private@<publisher>`
  return (
    /^publish:packs@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(s) ||
    /^read:private@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(s)
  );
}, "invalid token scope");

export const TOKEN_PREFIX = "wgp_live_";
export const TOKEN_BODY_LENGTH = 32;
export const TOKEN_TOTAL_LENGTH = TOKEN_PREFIX.length + TOKEN_BODY_LENGTH;
export const TOKEN_REGEX = /^wgp_live_[0-9a-f]{32}$/;

export const tokenSchema = z.string().regex(TOKEN_REGEX, "invalid wgp_live_ token");

// ---------------------------------------------------------------------------
// PublishInit request/response
// ---------------------------------------------------------------------------

export const publishFileEntrySchema = z.object({
  path: relativePathSchema,
  sha256: sha256HexSchema,
  bytes: z.number().int().nonnegative(),
  atomId: z.string().min(1).optional(),
});

export type PublishFileEntry = z.infer<typeof publishFileEntrySchema>;

export const publishCompatibilitySchema = z.object({
  target: platformTargetSchema,
  status: compatibilityStatusSchema,
});

export const publishMetadataSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  compatibilities: z.array(publishCompatibilitySchema).default([]),
});

export type PublishMetadata = z.infer<typeof publishMetadataSchema>;

export const publishInitRequestSchema = z.object({
  publisher: slugSchema,
  pack: slugSchema,
  version: semverSchema,
  manifestSha256: sha256HexSchema,
  files: z.array(publishFileEntrySchema).min(1),
  metadata: publishMetadataSchema,
});

export type PublishInitRequest = z.infer<typeof publishInitRequestSchema>;

export const presignedUploadSchema = z.object({
  path: relativePathSchema,
  url: z.string().url(),
  headers: z.record(z.string()),
});

export type PresignedUpload = z.infer<typeof presignedUploadSchema>;

export const publishInitResponseSchema = z.object({
  publishId: z.string().uuid(),
  expiresAt: z.string(),
  presignedUploads: z.array(presignedUploadSchema),
});

export type PublishInitResponse = z.infer<typeof publishInitResponseSchema>;

// ---------------------------------------------------------------------------
// PublishFinalize request/response
// ---------------------------------------------------------------------------

export const publishFinalizeRequestSchema = z.object({
  publishId: z.string().uuid(),
});

export type PublishFinalizeRequest = z.infer<typeof publishFinalizeRequestSchema>;

export const publishFinalizeResponseSchema = z.object({
  packId: z.string().uuid(),
  versionId: z.string().uuid(),
  url: z.string().url(),
});

export type PublishFinalizeResponse = z.infer<typeof publishFinalizeResponseSchema>;

export const sizeMismatchEntrySchema = z.object({
  path: relativePathSchema,
  expected: z.number().int().nonnegative(),
  got: z.union([z.number().int().nonnegative(), z.literal("missing")]),
});

export const publishSizeMismatchResponseSchema = z.object({
  error: z.literal("size_mismatch"),
  mismatched: z.array(sizeMismatchEntrySchema),
});

export type PublishSizeMismatchResponse = z.infer<
  typeof publishSizeMismatchResponseSchema
>;

// ---------------------------------------------------------------------------
// Read API shapes
// ---------------------------------------------------------------------------

export const registryVersionEntrySchema = z.object({
  version: semverSchema,
  publishedAt: z.string(),
  status: versionStatusSchema,
});

export const registryPackSchema = z.object({
  publisher: slugSchema,
  pack: slugSchema,
  description: z.string(),
  tags: z.array(z.string()),
  versions: z.array(registryVersionEntrySchema),
  latestVersion: semverSchema.nullable(),
});

export type RegistryPack = z.infer<typeof registryPackSchema>;

export const registryFileSchema = z.object({
  path: relativePathSchema,
  sha256: sha256HexSchema,
  bytes: z.number().int().nonnegative(),
  atomId: z.string().min(1).optional(),
});

export type RegistryFile = z.infer<typeof registryFileSchema>;

export const registryVersionSchema = z.object({
  publisher: slugSchema,
  pack: slugSchema,
  version: semverSchema,
  status: versionStatusSchema,
  manifestSha256: sha256HexSchema,
  publishedAt: z.string(),
  files: z.array(registryFileSchema),
});

export type RegistryVersion = z.infer<typeof registryVersionSchema>;

export const registrySearchResultSchema = z.object({
  publisher: slugSchema,
  pack: slugSchema,
  description: z.string(),
  tags: z.array(z.string()),
  latestVersion: semverSchema.nullable(),
  rank: z.number(),
});

export type RegistrySearchResult = z.infer<typeof registrySearchResultSchema>;

// ---------------------------------------------------------------------------
// Error response envelopes
// ---------------------------------------------------------------------------

export const errorResponseSchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const versionExistsResponseSchema = z.object({
  error: z.literal("version_exists"),
  existing: z
    .object({
      publishedAt: z.string(),
      publishedBy: z.string().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// CLI device-code auth (used by `workgraph login`)
// ---------------------------------------------------------------------------

export const cliAuthInitRequestSchema = z.object({
  clientName: z.string().min(1).default("workgraph-cli"),
});

export const cliAuthInitResponseSchema = z.object({
  deviceCode: z.string().min(8),
  userCode: z.string().min(4),
  verificationUrl: z.string().url(),
  expiresAt: z.string(),
  interval: z.number().int().positive(),
});

export type CliAuthInitResponse = z.infer<typeof cliAuthInitResponseSchema>;

export const cliAuthPollRequestSchema = z.object({
  deviceCode: z.string().min(8),
});

export const cliAuthPollResponseSchema = z.union([
  z.object({
    status: z.literal("pending"),
  }),
  z.object({
    status: z.literal("complete"),
    token: tokenSchema,
    user: z.object({
      id: z.string().uuid(),
      username: z.string(),
      publisherSlugs: z.array(slugSchema),
    }),
  }),
  z.object({
    status: z.literal("expired"),
  }),
]);

export type CliAuthPollResponse = z.infer<typeof cliAuthPollResponseSchema>;

// ---------------------------------------------------------------------------
// Type re-exports for convenience
// ---------------------------------------------------------------------------

export type { ProfileName, RiskLevel };

// ---------------------------------------------------------------------------
// Default registry URL — overridable via `--registry` flag or `WORKGRAPH_REGISTRY`
// env var. Pinned here so worktree agents don't drift on the literal.
// ---------------------------------------------------------------------------

export const DEFAULT_REGISTRY_URL = "https://registry.workgraph.dev";
