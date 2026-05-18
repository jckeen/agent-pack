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

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * End-to-end planner: resolves atoms for the given profile, computes risk +
 * permissions, runs the adapter to produce a file plan, and surfaces
 * warnings (atom-level and adapter-level) in one object.
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
  warnings.push(...risk.reasons.filter((r) => RISK_ORDER[risk.level] >= 2 ? true : false));
  warnings.push(...adapterResult.warnings);

  // Surface secret requirements as warnings (so a `plan` command at the CLI
  // can show them prominently).
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
