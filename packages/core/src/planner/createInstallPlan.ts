import type {
  AdapterOutputFile,
  AgentPackAdapter,
  AgentPackManifest,
  InstallPlan,
  RiskLevel,
  TargetPlatform,
} from "../schema/types.js";
import { computeRisk } from "../risk/computeRisk.js";
import { summarizePermissions } from "../permissions/summarizePermissions.js";
import { resolveAtoms } from "./resolveAtoms.js";

export interface CreateInstallPlanOptions {
  manifest: AgentPackManifest;
  packRoot: string;
  target: TargetPlatform;
  profile: string;
  adapter: AgentPackAdapter;
  onlyAtoms?: string[];
}

/**
 * End-to-end planner: resolves atoms for the given profile, computes risk +
 * permissions, runs the adapter to produce a file plan, and surfaces
 * warnings (atom-level and adapter-level) in one object.
 *
 * Warning ordering is stable: declared security risk_summary → risk reasons
 * (only when overall risk is medium+) → adapter warnings → secret requirements.
 */
export async function createInstallPlan(
  options: CreateInstallPlanOptions,
): Promise<InstallPlan> {
  const { manifest, packRoot, target, profile, adapter, onlyAtoms } = options;
  const resolved = resolveAtoms({ manifest, profile, onlyAtoms });
  const permissions = summarizePermissions(manifest, resolved);
  const risk = computeRisk(manifest, resolved, permissions);
  const adapterResult = await adapter.export({
    manifest,
    packRoot,
    resolvedAtoms: resolved,
    profile,
    target,
  });

  const warnings: string[] = [];
  if (manifest.security?.risk_summary) warnings.push(manifest.security.risk_summary);

  // Include risk reasons only when the overall plan is non-trivial. For
  // `low` plans the reasons list is just "atom X is low" noise; for medium+
  // plans the reasons explain why the level rose. We surface every reason
  // (no dedupe — the audit trail is the value) when level is medium or above.
  const RISK_ORDER: Record<RiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  if (RISK_ORDER[risk.level] >= RISK_ORDER.medium) {
    warnings.push(...risk.reasons);
  }

  warnings.push(...adapterResult.warnings);

  for (const s of permissions.secrets) {
    warnings.push(
      `Secret \`${s.name}\` required${s.requiredFor.length ? ` for ${s.requiredFor.join(", ")}` : ""}.`,
    );
  }

  return {
    packId: manifest.metadata.id,
    packVersion: manifest.metadata.version,
    target,
    profile,
    atoms: resolved.map((r) => r.atom.id),
    riskLevel: risk.level,
    permissions,
    warnings,
    files: adapterResult.files as AdapterOutputFile[],
    unsupportedAtoms: adapterResult.unsupportedAtoms,
  };
}
