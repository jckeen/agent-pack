import { z } from "zod";
import { ATOM_TYPES, TARGET_PLATFORMS } from "./types.js";

const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

const compatibilityStatusSchema = z.enum([
  "supported",
  "partial",
  "experimental",
  "unsupported",
]);

const targetPlatformSchema = z.enum(
  TARGET_PLATFORMS as unknown as [string, ...string[]],
);

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
        execution: z.enum(["required", "optional", "forbidden"]).optional(),
        commands: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    network: z
      .object({
        access: z.enum(["required", "optional", "forbidden"]).optional(),
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

const baseAtomFields = {
  id: z.string().regex(/^[a-z_]+:[a-z0-9][a-z0-9._-]*$/i, {
    message: "Atom id must be `<type>:<slug>`",
  }),
  type: atomTypeSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  path: z.string().min(1),
  risk_level: riskLevelSchema,
  permissions: z.array(z.string()).optional(),
  platforms: atomPlatformsSchema,
};

// Atom schema is intentionally permissive on type-specific extras so the
// example pack's hook/mcp/skill/rule/command atoms validate without losing
// fields. We do strong typing in TypeScript; zod just ensures the base shape.
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
    atoms: z.array(atomSchema).min(1),
    exports: exportsSchema,
    adapters: adaptersSchema,
  })
  .strict();

export type ParsedManifest = z.infer<typeof agentPackManifestSchema>;
