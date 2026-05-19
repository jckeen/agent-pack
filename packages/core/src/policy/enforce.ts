/**
 * `enforcePolicy` checks a planned remote-install against the loaded
 * `workgraph.policy.json`. Returns all violations at once (not just the first)
 * so the user sees the full picture in one shot.
 *
 * Order: registry → publisher → blockedPack → signature → profile → atomType.
 */

import type { PolicyConfig } from "./schema.js";

export interface PolicyEnforcementPlan {
  packId: string;
  publisher: string;
  pack: string;
  target: string;
  profile: string;
  atomTypes: string[];
  signed: boolean;
}

export interface PolicyViolation {
  code:
    | "registry"
    | "publisher"
    | "blockedPack"
    | "unsigned"
    | "profile"
    | "atomType";
  message: string;
  hint?: string;
}

export type PolicyEnforcementResult =
  | { ok: true }
  | { ok: false; violations: PolicyViolation[] };

export function enforcePolicy(
  policy: PolicyConfig | null,
  plan: PolicyEnforcementPlan,
  registryUrl: string
): PolicyEnforcementResult {
  if (!policy) {
    return { ok: true };
  }
  const violations: PolicyViolation[] = [];

  // 1. Registry allowlist.
  if (
    policy.registries.allowed.length > 0 &&
    !policy.registries.allowed.includes(registryUrl)
  ) {
    violations.push({
      code: "registry",
      message: `registry not in allowlist: ${registryUrl}`,
      hint: `allowed: ${policy.registries.allowed.join(", ")}`,
    });
  }

  // 2. Publisher allowlist.
  const publishers = policy.packs.allowedPublishers;
  if (publishers && publishers.length > 0 && !publishers.includes(plan.publisher)) {
    violations.push({
      code: "publisher",
      message: `publisher not allowed: ${plan.publisher}`,
      hint: `allowed: ${publishers.join(", ")}`,
    });
  }

  // 3. Blocked packs.
  const blocked = policy.packs.blockedPacks ?? [];
  const fullId = `${plan.publisher}/${plan.pack}`;
  if (blocked.includes(fullId) || blocked.includes(plan.packId)) {
    violations.push({
      code: "blockedPack",
      message: `pack is blocked: ${fullId}`,
    });
  }

  // 4. Signature requirement (Phase 4-ready; always fails until Phase 4 lands).
  if (policy.install.requireSignature && !plan.signed) {
    violations.push({
      code: "unsigned",
      message: `policy requires signed packs; ${fullId}@${plan.target}/${plan.profile} is unsigned`,
      hint: "Phase 4 (cosign keyless signing) is not yet implemented",
    });
  }

  // 5. Profile allowlist.
  const profiles = policy.install.allowedProfiles;
  if (profiles && profiles.length > 0 && !profiles.includes(plan.profile)) {
    violations.push({
      code: "profile",
      message: `profile not allowed: ${plan.profile}`,
      hint: `allowed: ${profiles.join(", ")}`,
    });
  }

  // 6. Denied atom types.
  const denied = policy.install.deniedAtomTypes ?? [];
  const hit = plan.atomTypes.filter((t) => denied.includes(t as never));
  if (hit.length > 0) {
    violations.push({
      code: "atomType",
      message: `plan contains denied atom types: ${[...new Set(hit)].join(", ")}`,
    });
  }

  if (violations.length === 0) return { ok: true };
  return { ok: false, violations };
}
