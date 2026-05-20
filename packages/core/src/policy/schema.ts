/**
 * `agentpack.policy.json` v1 schema. Source of truth: `Plans/PROTOCOL.md` § 7.
 */

import { z } from "zod";

import {
  atomTypeSchema,
  profileNameSchema,
  slugSchema,
} from "../protocol/index.js";

export const POLICY_VERSION = 1 as const;

export const policyConfigSchema = z.object({
  policyVersion: z.literal(POLICY_VERSION),
  registries: z
    .object({
      allowed: z.array(z.string().url()).default([]),
      default: z.string().url().optional(),
    })
    .default({ allowed: [] }),
  packs: z
    .object({
      allowedPublishers: z.array(slugSchema).optional(),
      blockedPacks: z.array(z.string().min(1)).optional(),
    })
    .default({}),
  install: z
    .object({
      requireSignature: z.boolean().optional(),
      allowedProfiles: z.array(profileNameSchema).optional(),
      deniedAtomTypes: z.array(atomTypeSchema).optional(),
    })
    .default({}),
  verify: z
    .object({
      onInstall: z.enum(["off", "warn", "required"]).optional(),
      chain: z.enum(["off", "warn", "required"]).optional(),
    })
    .default({}),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
