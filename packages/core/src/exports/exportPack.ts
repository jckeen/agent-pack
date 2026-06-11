import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AdapterOutputFile,
  InstallPlan,
  TargetPlatform,
} from "../schema/types.js";
import { getAdapter } from "../adapters/index.js";
import { loadManifest } from "../parser/loadManifest.js";
import { validateManifest } from "../validator/validateManifest.js";
import { createInstallPlan } from "../planner/createInstallPlan.js";
import { UnknownProfileError } from "../planner/resolveAtoms.js";

export interface ExportPackOptions {
  /** Path to the pack directory or AGENTPACK.yaml file. */
  source: string;
  target: TargetPlatform;
  profile?: string;
  outDir: string;
  /**
   * When true, throw on validation errors before exporting. Default: true.
   * Setting to false is only useful for debugging partial exports.
   */
  strict?: boolean;
  /** Only export these atom IDs (subset of resolved). */
  onlyAtoms?: string[];
  /**
   * When true, allow exporting even when atoms reference missing body files.
   * Default: false. Without this flag, an atom whose file/skill directory is
   * not present is a hard error — silently emitting a degenerate stub is the
   * worst-case "looks complete, ships wrong" failure mode (Cf. silent-failure
   * audit finding #3).
   */
  allowMissingBodies?: boolean;
}

export interface ExportResult {
  plan: InstallPlan;
  writtenFiles: string[];
  outDir: string;
}

const MISSING_BODY_WARNING_PATTERNS = [
  /directory not found at/i,
  /minimal SKILL\.md/i,
  /not found at `/i,
];

/**
 * High-level export entry: loads → validates → plans → writes files to outDir.
 * Never writes outside outDir. Returns the InstallPlan plus a list of files
 * actually written to disk.
 *
 * Strict mode (default ON):
 *  - Manifest validation errors abort before export.
 *  - Adapter warnings that indicate a missing atom body abort before write,
 *    unless `allowMissingBodies` is true.
 */
export async function exportPack(options: ExportPackOptions): Promise<ExportResult> {
  const strict = options.strict ?? true;
  const allowMissing = options.allowMissingBodies ?? false;
  const loaded = await loadManifest(options.source);
  const validation = validateManifest(loaded.manifest);
  if (!validation.valid && strict) {
    const detail = validation.errors
      .map((e) => `[${e.code}] ${e.path}: ${e.message}`)
      .join("\n");
    throw new Error(`AgentPack manifest failed validation:\n${detail}`);
  }
  const adapter = getAdapter(options.target);
  const profile = resolveProfile(loaded.manifest, options.profile);
  const plan = await createInstallPlan({
    manifest: loaded.manifest,
    packRoot: loaded.packRoot,
    target: options.target,
    profile,
    adapter,
    onlyAtoms: options.onlyAtoms,
  });

  if (strict && !allowMissing) {
    const missingBodyWarnings = plan.warnings.filter((w) =>
      MISSING_BODY_WARNING_PATTERNS.some((rx) => rx.test(w)),
    );
    if (missingBodyWarnings.length > 0) {
      throw new Error(
        `Export aborted: atom body files missing — exporting would produce a degenerate output.\n` +
          missingBodyWarnings.map((w) => `  • ${w}`).join("\n") +
          `\nFix the manifest paths, or pass \`--allow-missing\` (CLI) / \`allowMissingBodies: true\` (API) to proceed.`,
      );
    }
  }

  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const file of plan.files) {
    const absPath = path.resolve(outDir, file.path);
    if (!isInside(outDir, absPath)) {
      throw new Error(
        `Refusing to write file outside outDir: ${file.path} → ${absPath}`,
      );
    }
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, normalizeContent(file), "utf8");
    written.push(path.relative(outDir, absPath));
  }
  return { plan, writtenFiles: written, outDir };
}

function resolveProfile(
  manifest: { profiles: Record<string, unknown>; exports?: { default_profile?: string } },
  requested?: string,
): string {
  if (requested) {
    if (!manifest.profiles[requested]) {
      throw new UnknownProfileError(requested, Object.keys(manifest.profiles));
    }
    return requested;
  }
  const declaredDefault = manifest.exports?.default_profile;
  if (declaredDefault) {
    if (!manifest.profiles[declaredDefault]) {
      throw new Error(
        `\`exports.default_profile: ${declaredDefault}\` does not match any declared profile.`,
      );
    }
    return declaredDefault;
  }
  if (manifest.profiles.safe) return "safe";
  // No requested profile, no declared default, no safe profile — refuse to
  // silently fall through. Force the caller to be explicit.
  const declared = Object.keys(manifest.profiles).join(", ");
  throw new Error(
    `No profile specified and pack declares no \`exports.default_profile\` (or \`safe\`). Specify --profile <one of: ${declared}>.`,
  );
}

function normalizeContent(file: AdapterOutputFile): string {
  return file.content.endsWith("\n") ? file.content : `${file.content}\n`;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
