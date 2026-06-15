import { z } from "zod";
import { ATOM_TYPES, TARGET_PLATFORMS } from "./types.js";

const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

const compatibilityStatusSchema = z.enum([
  "supported",
  "partial",
  "experimental",
  "unsupported",
]);

// A capability level: required | optional | forbidden. "none" is accepted as an
// author-friendly alias for "forbidden" — a guidance-only pack naturally writes
// an unused capability (shell, network) as "none". Normalized here at the schema
// boundary so the rest of the codebase only ever sees the canonical three values.
const capabilityLevelSchema = z.preprocess(
  (v) => (v === "none" ? "forbidden" : v),
  z.enum(["required", "optional", "forbidden"]),
);

const targetPlatformSchema = z.enum(TARGET_PLATFORMS as unknown as [string, ...string[]]);

const atomTypeSchema = z.enum(ATOM_TYPES as unknown as [string, ...string[]]);

const authorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  url: z.string().url().optional(),
});

const metadataSchema = z.object({
  id: z
    .string()
    .min(3)
    // publisher.slug — alphanumerics, dot, underscore, hyphen. Case-folded
    // via the validator's duplicate-id check; the regex stays case-insensitive
    // for human ergonomics, but `validateManifest` lowercases for uniqueness.
    .regex(/^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*$/i, {
      message: "Pack id must be `publisher.slug` (lowercase letters, digits, ._-)",
    }),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  license: z.string().optional(),
  publisher: z.string().min(1),
  authors: z.array(authorSchema).optional(),
  tags: z.array(z.string()).optional(),
  homepage: z.string().url().optional(),
  repository: z.string().optional(),
});

const compatibilityTargetSchema = z.object({
  status: compatibilityStatusSchema,
  notes: z.string().optional(),
  minVersion: z.string().optional(),
});

const compatibilitySchema = z.object({
  targets: z.record(targetPlatformSchema, compatibilityTargetSchema),
});

const permissionsSchema = z
  .object({
    filesystem: z
      .object({
        read: z.array(z.string()).optional(),
        write: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    shell: z
      .object({
        execution: capabilityLevelSchema.optional(),
        commands: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    network: z
      .object({
        access: capabilityLevelSchema.optional(),
        domains: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    secrets: z
      .object({
        required: z
          .array(
            z.object({
              name: z.string(),
              description: z.string().optional(),
              required_for: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      })
      .partial()
      .optional(),
    mcp: z
      .object({
        servers: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    external_apis: z.array(z.string()).optional(),
    browser_access: z.boolean().optional(),
    repo_modification: z.boolean().optional(),
    git_operations: z.array(z.string()).optional(),
    package_installation: z.boolean().optional(),
    user_data_access: z.boolean().optional(),
    private_context_access: z.boolean().optional(),
    model_provider_key_access: z.boolean().optional(),
  })
  .partial()
  .optional();

const securitySchema = z
  .object({
    risk_level: riskLevelSchema.optional(),
    risk_summary: z.string().optional(),
    requires_review: z.boolean().optional(),
    signed: z.boolean().optional(),
    sandbox_recommended: z.boolean().optional(),
    checksums: z
      .object({ enabled: z.boolean().optional(), file: z.string().optional() })
      .partial()
      .optional(),
    provenance: z
      .object({ enabled: z.boolean().optional(), file: z.string().optional() })
      .partial()
      .optional(),
  })
  .partial()
  .optional();

const profileSchema = z
  .object({
    description: z.string().optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
    policy: z.record(z.unknown()).optional(),
  })
  .partial();

const dependenciesSchema = z
  .object({
    tools: z
      .array(
        z.object({
          name: z.string(),
          required: z.boolean().optional(),
          version: z.string().optional(),
        }),
      )
      .optional(),
    packs: z
      .array(
        z.object({
          id: z.string(),
          version: z.string().optional(),
          optional: z.boolean().optional(),
        }),
      )
      .optional(),
    mcp_servers: z
      .array(
        z.object({
          id: z.string(),
          package: z.string().optional(),
          version: z.string().optional(),
          optional: z.boolean().optional(),
        }),
      )
      .optional(),
  })
  .partial()
  .optional();

const atomPlatformsSchema = z
  .record(targetPlatformSchema, compatibilityStatusSchema)
  .optional();

/**
 * `atom.path` is the on-disk file or directory backing the atom. It must be:
 *  - a non-empty relative path
 *  - not absolute (no leading `/` or `C:\`)
 *  - not contain any `..` traversal segment
 *  - not start with `~`
 *
 * Symlink-escape (where the path is in-pack lexically but resolves outside)
 * is enforced at I/O time in adapters/types.ts via realpath comparison.
 */
/**
 * Windows reserved device names — these are kernel-level reserved and any
 * filesystem write to them returns EINVAL on Windows, regardless of the
 * application. A pack distributed cross-platform must not contain them.
 */
const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

const atomPathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("~"), {
    message: "atom.path must not start with `~` (no home expansion)",
  })
  .refine((p) => !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(p), {
    message: "atom.path must be a relative path inside the pack (not absolute)",
  })
  .refine((p) => !p.split(/[\\/]+/).includes(".."), {
    message: "atom.path must not contain `..` traversal segments",
  })
  .refine(
    (p) => {
      // Any segment matching a Windows reserved name fails the write on
      // Windows. Reject at validate time so authors find out before
      // shipping. From qa-lead 2026-05-19 (iter-5 LOW-7).
      const segments = p.split(/[\\/]+/).filter(Boolean);
      return !segments.some((s) => WINDOWS_RESERVED_BASENAME_RE.test(s));
    },
    {
      message:
        "atom.path contains a Windows-reserved name (CON, PRN, AUX, NUL, COM0-9, LPT0-9) which fails kernel-level writes on Windows",
    },
  );

const baseAtomFields = {
  id: z
    .string()
    .regex(/^[a-z_]+:[a-z0-9][a-z0-9._-]*$/i, {
      message: "Atom id must be `<type>:<slug>` (slug = lowercase letters, digits, ._-)",
    })
    // Reject `..` inside the slug — although the slug can't contain `/`, the
    // slug is interpolated into file paths (e.g. `.claude/skills/<slug>/`)
    // and a slug of `..` would walk up the output tree. Guard the split: if
    // the id has no `:` (already rejected by the regex above), the earlier
    // error is the one the user should see.
    .refine(
      (id) => {
        const slug = id.split(":")[1];
        return slug === undefined || !slug.split(".").includes("");
      },
      {
        message: "Atom id slug must not contain empty segments (e.g. `..`)",
      },
    ),
  type: atomTypeSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  path: atomPathSchema,
  risk_level: riskLevelSchema,
  permissions: z.array(z.string()).optional(),
  platforms: atomPlatformsSchema,
};

// Atom schema is permissive on type-specific extras so the example pack's
// hook/mcp/skill/rule/command atoms validate without losing fields. We do
// strong typing in TypeScript; zod just ensures the base shape.
const atomSchema = z
  .object({
    ...baseAtomFields,
  })
  .passthrough();

const exportsSchema = z
  .object({
    default_profile: z.string().optional(),
    output_dir: z.string().optional(),
    lockfile: z.string().optional(),
    include_readme: z.boolean().optional(),
  })
  .partial()
  .optional();

const adapterEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
    experimental: z.boolean().optional(),
    output: z.record(z.string()).optional(),
  })
  .partial();

const adaptersSchema = z.record(adapterEntrySchema).optional();

export const agentPackManifestSchema = z
  .object({
    agentpack: z.string().regex(/^1\.\d+/, {
      message: "`agentpack` version must match `1.x`",
    }),
    metadata: metadataSchema,
    compatibility: compatibilitySchema,
    permissions: permissionsSchema,
    security: securitySchema,
    profiles: z.record(profileSchema),
    dependencies: dependenciesSchema,
    atoms: z.array(atomSchema).min(1).max(10_000),
    exports: exportsSchema,
    adapters: adaptersSchema,
  })
  .strict();

export type ParsedManifest = z.infer<typeof agentPackManifestSchema>;
