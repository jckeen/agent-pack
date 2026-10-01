import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AdapterOutputFile,
  AgentPackManifest,
  InstallPlan,
  TargetPlatform,
} from "../schema/types.js";
import { getAdapter } from "../adapters/index.js";
import { loadManifest } from "../parser/loadManifest.js";
import { validateManifest } from "../validator/validateManifest.js";
import { createInstallPlan } from "../planner/createInstallPlan.js";
import { UnknownProfileError } from "../planner/resolveAtoms.js";
import { mapOutputToUserScope, USER_SCOPE_TARGETS } from "../install/userScope.js";
import {
  assertNoPathConflicts,
  prepareOutDir,
  writeContainedFile,
} from "./outputSafety.js";

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
  /**
   * Output layout, relative to outDir. User scope maps paths into the runtime's
   * user-config layout and renders generated references for that layout (#193).
   * Does not select or write to the actual user-config directory.
   */
  scope?: "project" | "user";
}

export interface ExportResult {
  plan: InstallPlan;
  writtenFiles: string[];
  outDir: string;
  /**
   * Files already in `outDir` that this pack emits for the same target under
   * another profile or atom selection, but not in this export. Reported (and
   * mirrored into `plan.warnings`), never deleted.
   */
  staleFiles: string[];
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
  if (options.scope === "user" && !USER_SCOPE_TARGETS.includes(options.target)) {
    throw new Error(
      `--scope user is only supported for targets ${USER_SCOPE_TARGETS.join(", ")} (got \`${options.target}\`).`,
    );
  }
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
    ...(options.scope ? { scope: options.scope } : {}),
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

  if (options.scope === "user") {
    for (const file of plan.files) {
      Object.assign(file, mapOutputToUserScope(options.target, file));
    }
  }

  const { outDir, realOut } = await prepareOutDir(options.outDir);
  assertNoPathConflicts(plan.files.map((f) => f.path));

  // A reused outDir can still hold what a wider profile wrote (#216). Unlike
  // the plugin/chat bundles, this directory may be a live project, so nothing
  // is deleted: paths this pack owns under another profile are reported.
  const staleFiles = await findStaleOutputs(realOut, plan, {
    manifest: loaded.manifest,
    packRoot: loaded.packRoot,
    target: options.target,
    adapter,
    ...(options.scope ? { scope: options.scope } : {}),
  });
  if (staleFiles.length > 0) {
    plan.warnings.push(
      `The output directory already contains ${staleFiles.length} file(s) this pack emits under another profile or atom selection, not \`${profile}\`: ${staleFiles.join(", ")}. They were left in place — remove them or export to an empty directory, or the directory will not match this profile.`,
    );
  }

  const written: string[] = [];
  for (const file of plan.files) {
    written.push(await writeContainedFile(realOut, file.path, normalizeContent(file)));
  }
  return { plan, writtenFiles: written, outDir, staleFiles };
}

/**
 * Paths under `realOut` that exist on disk and that this pack would emit for
 * the same target under SOME profile, but not in the current plan. Scoped to
 * the pack's own outputs, so unrelated files in the directory never appear.
 */
async function findStaleOutputs(
  realOut: string,
  plan: InstallPlan,
  ctx: {
    manifest: AgentPackManifest;
    packRoot: string;
    target: TargetPlatform;
    adapter: ReturnType<typeof getAdapter>;
    scope?: "project" | "user";
  },
): Promise<string[]> {
  const current = new Set(plan.files.map((f) => f.path));
  const candidates = new Set<string>();
  for (const profile of Object.keys(ctx.manifest.profiles)) {
    let other: InstallPlan;
    try {
      other = await createInstallPlan({
        manifest: ctx.manifest,
        packRoot: ctx.packRoot,
        target: ctx.target,
        profile,
        adapter: ctx.adapter,
        ...(ctx.scope ? { scope: ctx.scope } : {}),
      });
    } catch {
      // A profile that cannot be planned could not have been exported either.
      continue;
    }
    for (const file of other.files) {
      const mapped =
        ctx.scope === "user" ? mapOutputToUserScope(ctx.target, file).path : file.path;
      if (!current.has(mapped)) candidates.add(mapped);
    }
  }
  const stale: string[] = [];
  for (const rel of [...candidates].sort()) {
    if (await fs.lstat(path.join(realOut, rel)).catch(() => null)) stale.push(rel);
  }
  return stale;
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
