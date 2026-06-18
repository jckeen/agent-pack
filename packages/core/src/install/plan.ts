import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createPatch } from "diff";
import type { AdapterOutputFile, ProfileName, TargetPlatform } from "../schema/types.js";
import type { InstallPlanV2, DiffEntry, LockfileV1 } from "./types.js";
import { exportPack } from "../exports/exportPack.js";
import { loadManifest } from "../parser/loadManifest.js";
import { resolveAgentpackPaths, ensureAgentpackDirs, realpathContained } from "./paths.js";
import { buildLockfile } from "./lockfile.js";
import { normalizeForHash, sha256Hex } from "./checksum.js";
import {
  isMarkerBlock,
  mergeMarkerFile,
  mergeJsonConfig,
  JSON_MERGE_PATHS,
  type MergeRecord,
} from "./merge.js";
import { readInstallManifest, InstallManifestNotFoundError } from "./manifest.js";

const BEGIN_MARKER = /<!--\s*BEGIN AGENTPACK:\s*([\w.\-/]+)\s*-->/;

export interface PlanInstallOptions {
  /** Path to the pack directory or AGENTPACK.yaml file. */
  source: string;
  target: TargetPlatform;
  /**
   * Profile to install. When omitted, `exportPack` resolves the pack's declared
   * `exports.default_profile` (then a `safe` profile, else refuses) — the CLI
   * must NOT pre-fill "safe", or imported packs that declare only `all` break (#86).
   */
  profile?: ProfileName;
  /** User's project root — where the install will land. */
  projectRoot: string;
  /** Generator versions stamped into the lockfile. */
  generator: { cli: string; adapter: string };
  /** Allow file body to be missing — defaults to false. */
  allowMissingBodies?: boolean;
}

/**
 * Plan an install:
 *
 *   1. Export the pack into an in-memory staging area.
 *   2. For every adapter output file, classify it against the user's project:
 *      - `created` — no file at the target path yet
 *      - `unchanged` — file exists with byte-identical content (we'd write the
 *        same thing; skip)
 *      - `modified` — file exists with our marker, content differs (safe to
 *        overwrite)
 *      - `conflict` — file exists without our marker AND differs (refuse
 *        without --force)
 *      - `conflict (other-pack-marker)` — file has another pack's marker
 *   3. Build the LockfileV1 from the staged files (deterministic; no timestamps).
 */
export async function planInstall(opts: PlanInstallOptions): Promise<InstallPlanV2> {
  const ws = await resolveAgentpackPaths(opts.projectRoot);
  await ensureAgentpackDirs(ws);
  const loaded = await loadManifest(opts.source);

  // We reuse exportPack's staging logic by writing to a temp dir. This keeps
  // export semantics single-sourced. The temp dir is cleaned at the end.
  const tmp = await fs.mkdtemp(path.join(ws.agentpackDir, ".plan-staging-"));
  try {
    const result = await exportPack({
      source: opts.source,
      target: opts.target,
      profile: opts.profile,
      outDir: tmp,
      strict: true,
      allowMissingBodies: opts.allowMissingBodies,
    });
    const planFiles = result.plan.files;
    // Snapshot the pack's pristine contribution per path BEFORE any merge
    // rewrites staged content. The lockfile must hash the pack's output (so
    // it stays deterministic and reproducible across projects), and merge
    // records pin the same fragment for drift checks + surgical uninstall.
    const pristine = new Map(planFiles.map((f) => [f.path, normalizeContent(f)]));
    // Prior install manifest (re-install case): lets the JSON merge replace
    // entries this pack contributed last time instead of colliding with them.
    let priorManifest = null;
    try {
      priorManifest = await readInstallManifest(ws, result.plan.packId);
    } catch (err) {
      if (!(err instanceof InstallManifestNotFoundError)) throw err;
    }
    const created: AdapterOutputFile[] = [];
    const modified: AdapterOutputFile[] = [];
    const unchanged: AdapterOutputFile[] = [];
    const conflicts: InstallPlanV2["conflicts"] = [];
    const merges: MergeRecord[] = [];
    for (const f of planFiles) {
      // Refuse to escape projectRoot before classifying.
      const absTarget = path.resolve(ws.projectRoot, f.path);
      await realpathContained(ws.projectRoot, absTarget);
      const plannedContent = pristine.get(f.path) ?? normalizeContent(f);
      const recordMerge = (strategy: MergeRecord["strategy"]) => {
        merges.push({
          path: f.path,
          strategy,
          fragment: plannedContent,
          fragmentSha256: sha256Hex(normalizeForHash(plannedContent)),
        });
      };
      const cls = await classify({
        absTarget,
        plannedContent,
        packId: result.plan.packId,
        relPath: f.path,
        priorFragment: priorManifest?.merges?.find((m) => m.path === f.path)?.fragment,
      });
      switch (cls.kind) {
        case "create":
          created.push(f);
          // Merge-capable files get a record even on create: the user may
          // append their own content later, and uninstall must then remove
          // only our span/entries instead of deleting their file.
          if (isMarkerBlock(plannedContent)) recordMerge("marker");
          else if (JSON_MERGE_PATHS.has(f.path)) recordMerge("json");
          break;
        case "unchanged":
          unchanged.push(f);
          if (isMarkerBlock(plannedContent)) recordMerge("marker");
          else if (JSON_MERGE_PATHS.has(f.path)) recordMerge("json");
          break;
        case "modify":
          modified.push(f);
          break;
        case "merge":
          // Stage the merged result — apply writes files verbatim, so the
          // merge must happen here. The lockfile + merge record keep the
          // pack's pristine fragment.
          f.content = cls.mergedContent;
          modified.push(f);
          recordMerge(cls.strategy);
          break;
        case "conflict":
          conflicts.push({
            file: f,
            reason: cls.reason,
            existingSha256: cls.existingSha256,
            otherPackId: cls.otherPackId,
          });
          break;
      }
    }
    // Build the lockfile. Group output files by atom id from the resolved
    // atom list. We need atomId → set of files. Phase 1 doesn't tag files with
    // atoms, so we approximate: every file emitted by an adapter belongs to
    // the set of resolved atoms (in aggregate). Phase 4 will refine. For
    // Phase 2 determinism, we attribute every file to a synthetic "*pack"
    // atom alongside the real atom list — the lockfile still pins every
    // file's hash explicitly.
    const lock = buildLockfile({
      packId: result.plan.packId,
      packVersion: result.plan.packVersion,
      target: opts.target,
      profile: result.plan.profile,
      generator: opts.generator,
      manifestRawBytes: loaded.rawYaml,
      atomOutputs: [
        {
          atomId: "*pack",
          atomType: "instruction",
          sourceBytes: loaded.rawYaml,
          files: planFiles,
          fileHashes: planFiles.map((f) => {
            // Hash the pack's PRISTINE contribution, not merge-rewritten
            // staged content — the lockfile must stay deterministic across
            // projects regardless of what user content a merge preserved.
            const content = pristine.get(f.path) ?? normalizeContent(f);
            return {
              path: f.path,
              sha256: sha256Hex(normalizeForHash(content)),
              bytes: Buffer.byteLength(normalizeForHash(content), "utf8"),
              action: f.action,
            };
          }),
        },
      ],
    });
    return {
      packId: result.plan.packId,
      packVersion: result.plan.packVersion,
      target: opts.target,
      profile: result.plan.profile,
      atoms: result.plan.atoms,
      atomTypes: result.plan.atomTypes,
      riskLevel: result.plan.riskLevel,
      permissions: result.plan.permissions,
      warnings: result.plan.warnings,
      unsupportedAtoms: result.plan.unsupportedAtoms,
      projectRoot: ws.projectRoot,
      created,
      modified,
      unchanged,
      conflicts,
      merges,
      lockfile: lock,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

type Classification =
  | { kind: "create" }
  | { kind: "unchanged" }
  | { kind: "modify" }
  | { kind: "merge"; strategy: "marker" | "json"; mergedContent: string }
  | {
      kind: "conflict";
      reason: "no-marker-existing-content" | "other-pack-marker" | "json-collision";
      existingSha256: string;
      otherPackId?: string;
    };

async function classify(input: {
  absTarget: string;
  plannedContent: string;
  packId: string;
  relPath: string;
  /** This pack's fragment from a prior install of the same file, if any. */
  priorFragment?: string;
}): Promise<Classification> {
  let existing: string;
  try {
    existing = await fs.readFile(input.absTarget, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "create" };
    throw err;
  }
  const ourPlannedNormalized = normalizeForHash(input.plannedContent);
  const existingNormalized = normalizeForHash(existing);
  if (ourPlannedNormalized === existingNormalized) return { kind: "unchanged" };

  // Marker-block files (CLAUDE.md, AGENTS.md, ...) coexist with user content
  // and with other packs: merge our block in (replacing our previous span on
  // re-install) instead of demanding whole-file ownership.
  if (isMarkerBlock(input.plannedContent)) {
    const merged = mergeMarkerFile(existing, input.plannedContent, input.packId);
    if (normalizeForHash(merged) === existingNormalized) return { kind: "unchanged" };
    return { kind: "merge", strategy: "marker", mergedContent: merged };
  }

  // Known JSON config surfaces (.claude/settings.json, .mcp.json, ...) are
  // deep-merged: our entries are added, user/other-pack entries preserved.
  if (JSON_MERGE_PATHS.has(input.relPath)) {
    const res = mergeJsonConfig(existing, input.plannedContent, input.priorFragment);
    if (res.ok) {
      if (normalizeForHash(res.merged) === existingNormalized) return { kind: "unchanged" };
      return { kind: "merge", strategy: "json", mergedContent: res.merged };
    }
    return {
      kind: "conflict",
      reason: "invalidJson" in res ? "no-marker-existing-content" : "json-collision",
      existingSha256: sha256Hex(existingNormalized),
    };
  }

  const markerMatch = BEGIN_MARKER.exec(existing);
  if (!markerMatch) {
    return {
      kind: "conflict",
      reason: "no-marker-existing-content",
      existingSha256: sha256Hex(existingNormalized),
    };
  }
  const markedPackId = markerMatch[1];
  if (markedPackId === input.packId) {
    return { kind: "modify" };
  }
  return {
    kind: "conflict",
    reason: "other-pack-marker",
    existingSha256: sha256Hex(existingNormalized),
    otherPackId: markedPackId,
  };
}

function normalizeContent(f: AdapterOutputFile): string {
  return f.content.endsWith("\n") ? f.content : `${f.content}\n`;
}

/**
 * Produce a list of unified-diff entries describing the install. For modified
 * and conflict entries we synthesize a `diff` using the standard `diff` lib.
 */
export async function diffPlan(plan: InstallPlanV2): Promise<DiffEntry[]> {
  const out: DiffEntry[] = [];
  for (const f of plan.created) {
    out.push({ path: f.path, status: "create" });
  }
  for (const f of plan.modified) {
    const abs = path.resolve(plan.projectRoot, f.path);
    const existing = await fs.readFile(abs, "utf8").catch(() => "");
    const diff = createPatch(f.path, existing, normalizeContent(f), "current", "new");
    out.push({ path: f.path, status: "modify", diff });
  }
  for (const f of plan.unchanged) {
    out.push({ path: f.path, status: "unchanged" });
  }
  for (const c of plan.conflicts) {
    const abs = path.resolve(plan.projectRoot, c.file.path);
    const existing = await fs.readFile(abs, "utf8").catch(() => "");
    const diff = createPatch(
      c.file.path,
      existing,
      normalizeContent(c.file),
      "current",
      "new",
    );
    out.push({
      path: c.file.path,
      status: "conflict",
      diff,
      conflict: { reason: c.reason, otherPackId: c.otherPackId },
    });
  }
  return out;
}

/**
 * Re-export for callers that want the lockfile shape without reaching into
 * `./lockfile.js` directly.
 */
export type { LockfileV1 };
