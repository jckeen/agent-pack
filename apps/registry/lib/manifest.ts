import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  computeRisk,
  loadManifest,
  resolveAtoms,
  summarizePermissions,
  validateManifest,
  type AgentPackManifest,
  type PermissionSummary,
  type RiskLevel,
  type ResolvedAtom,
  type SeedPack,
  type ValidationResult,
} from "@workgraph/core";

export interface RegistryPackDetail {
  seed: SeedPack;
  manifest: AgentPackManifest | null;
  rawYaml: string | null;
  validation: ValidationResult | null;
  riskLevel: RiskLevel;
  permissionsByProfile: Record<string, PermissionSummary>;
  resolvedByProfile: Record<string, ResolvedAtom[]>;
}

/**
 * Resolve the absolute path to the repo root. Next.js runs commands from
 * `apps/registry/`, so we walk two levels up. We never reach this code from
 * the client bundle — `manifest.ts` is only imported by server components.
 */
function repoRoot(): string {
  const cwd = process.cwd();
  // dev/build cwd is .../apps/registry; if invoked from root, also fine.
  if (cwd.endsWith(path.join("apps", "registry"))) {
    return path.resolve(cwd, "..", "..");
  }
  return cwd;
}

export async function getPackDetail(
  seed: SeedPack,
): Promise<RegistryPackDetail> {
  if (!seed.examplePath) {
    return {
      seed,
      manifest: null,
      rawYaml: null,
      validation: null,
      riskLevel: seed.riskLevel,
      permissionsByProfile: {},
      resolvedByProfile: {},
    };
  }
  const absPackRoot = path.resolve(repoRoot(), seed.examplePath);
  const loaded = await loadManifest(absPackRoot);
  const validation = validateManifest(loaded.manifest);
  const profiles = Object.keys(loaded.manifest.profiles);
  const permissionsByProfile: Record<string, PermissionSummary> = {};
  const resolvedByProfile: Record<string, ResolvedAtom[]> = {};
  let aggregateRisk: RiskLevel = seed.riskLevel;
  for (const profile of profiles) {
    const resolved = resolveAtoms({
      manifest: loaded.manifest,
      profile,
    });
    resolvedByProfile[profile] = resolved;
    const perms = summarizePermissions(loaded.manifest, resolved);
    permissionsByProfile[profile] = perms;
    const risk = computeRisk(loaded.manifest, resolved, perms);
    aggregateRisk = highestRisk(aggregateRisk, risk.level);
  }
  return {
    seed,
    manifest: loaded.manifest,
    rawYaml: loaded.rawYaml,
    validation,
    riskLevel: aggregateRisk,
    permissionsByProfile,
    resolvedByProfile,
  };
}

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function highestRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export async function validateRawYaml(yaml: string): Promise<{
  parsed: unknown;
  result: ValidationResult | null;
  parseError: string | null;
}> {
  if (!yaml.trim()) {
    return {
      parsed: null,
      result: null,
      parseError: "Empty YAML.",
    };
  }
  try {
    const parsed = parseYaml(yaml);
    const result = validateManifest(parsed);
    return { parsed, result, parseError: null };
  } catch (err) {
    return {
      parsed: null,
      result: null,
      parseError: (err as Error).message,
    };
  }
}

export async function readExamplePackRaw(seed: SeedPack): Promise<string | null> {
  if (!seed.examplePath) return null;
  const file = path.resolve(repoRoot(), seed.examplePath, "AGENTPACK.yaml");
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}
