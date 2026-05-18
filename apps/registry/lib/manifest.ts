import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  computeRisk,
  loadManifest,
  parseManifestYaml,
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
 * Maximum YAML size accepted by the registry's `/validate` form. Mirror of
 * the core parser's limit (256 KiB chosen here — the server bears the cost
 * of a paste, so it's tighter than the on-disk limit).
 */
export const VALIDATE_MAX_BYTES = 256 * 1024;

/**
 * Resolve the absolute path to the repo root.
 *
 * Strategy:
 *  1. If `WORKGRAPH_REPO_ROOT` is set, use it (escape hatch for container
 *     deployments).
 *  2. Walk upward from `cwd` looking for `pnpm-workspace.yaml`.
 *  3. Fall back to `cwd` (with a warning to stderr in production).
 *
 * Returns the same value across the lifetime of the process — cached.
 */
let _repoRootCache: string | null = null;
function repoRoot(): string {
  if (_repoRootCache) return _repoRootCache;
  const env = process.env["WORKGRAPH_REPO_ROOT"];
  if (env) {
    _repoRootCache = path.resolve(env);
    return _repoRootCache;
  }
  let cur = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSyncSafe(path.join(cur, "pnpm-workspace.yaml"))) {
      _repoRootCache = cur;
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  _repoRootCache = process.cwd();
  return _repoRootCache;
}

function existsSyncSafe(p: string): boolean {
  try {
    require("node:fs").accessSync(p);
    return true;
  } catch {
    return false;
  }
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
  let loaded: Awaited<ReturnType<typeof loadManifest>>;
  try {
    loaded = await loadManifest(absPackRoot);
  } catch (err) {
    // Surface this loudly during build/CI; keep page render-able.
    if (process.env["NODE_ENV"] !== "production") {
      console.warn(
        `[registry] failed to load example pack \`${seed.id}\` from \`${absPackRoot}\`:`,
        (err as Error).message,
      );
    }
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
  const byteLength = Buffer.byteLength(yaml, "utf8");
  if (byteLength > VALIDATE_MAX_BYTES) {
    return {
      parsed: null,
      result: null,
      parseError: `Input too large (${byteLength} bytes). The validator caps at ${VALIDATE_MAX_BYTES} bytes.`,
    };
  }
  try {
    const parsed = parseManifestYaml(yaml, { maxBytes: VALIDATE_MAX_BYTES });
    const result = validateManifest(parsed);
    return { parsed, result, parseError: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log on the server with the full error; return the user-facing message.
    console.error("[registry] validateRawYaml parse error:", msg);
    return {
      parsed: null,
      result: null,
      parseError: msg,
    };
  }
}

export async function readExamplePackRaw(seed: SeedPack): Promise<string | null> {
  if (!seed.examplePath) return null;
  const file = path.resolve(repoRoot(), seed.examplePath, "AGENTPACK.yaml");
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT" && process.env["NODE_ENV"] !== "production") {
      console.warn(
        `[registry] readExamplePackRaw \`${file}\`:`,
        e.message,
      );
    }
    return null;
  }
}
