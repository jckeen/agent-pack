/**
 * `agentpack.policy.json` v1 schema. Source of truth: `Plans/PROTOCOL.md` § 7.
 */

import { z } from "zod";

import { atomTypeSchema, profileNameSchema, slugSchema } from "../protocol/index.js";

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
      // Signer-identity governance (ISC-289). `allowedSigners` is an org-wide
      // allowlist of acceptable Sigstore certificate identities (SANs); a
      // signed pack whose signer is not in the list is refused.
      // `requireIdentity` refuses an otherwise-valid signature whose signer is
      // unpinned (no `--expected-signer` and no `allowedSigners`) instead of
      // accepting it on trust-on-first-use.
      allowedSigners: z.array(z.string().min(1)).optional(),
      requireIdentity: z.boolean().optional(),
    })
    .default({}),
  verify: z
    .object({
      onInstall: z.enum(["off", "warn", "required"]).optional(),
      chain: z.enum(["off", "warn", "required"]).optional(),
    })
    .default({}),
  // Sync S2 (#111): governance over `agentpack update` — see docs/policy.md.
  update: z
    .object({
      /** Ceiling: installs may not track a channel looser than this
       * (pinned < tag < branch; registry `latest` counts as branch-loose). */
      channel: z.enum(["pinned", "tag", "branch"]).optional(),
      /** When re-consent (--allow-exec) is demanded. Default "exec": on an
       * exec-bearing delta. "always": on any delta. "never": only a
       * signature-verified update skips consent — an UNSIGNED exec delta
       * still requires --allow-exec (the install-grade floor never lowers). */
      requireReconsent: z.enum(["exec", "always", "never"]).optional(),
      /** Refuse updates whose computed risk exceeds the installed version's
       * by more than this. Default "any" (no gate). */
      maxRiskEscalation: z.enum(["none", "one-level", "any"]).optional(),
    })
    .default({}),
});

export type PolicyConfig = z.infer<typeof policyConfigSchema>;
