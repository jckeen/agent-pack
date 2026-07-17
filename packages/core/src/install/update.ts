/**
 * Sync S2 (#111): the `agentpack update` apply engine — a BASE-aware layer
 * over the install planner, per docs/sync-design.md §1.3.
 *
 * Inputs per file:
 *   BASE  = what the pack wrote at install time (install manifest hashes;
 *           merge fragments for marker/JSON files)
 *   LOCAL = on-disk now
 *   NEW   = the freshly fetched pack's staged output (`planInstall` result)
 *
 * Classification:
 *   LOCAL == BASE, NEW != BASE → clean update (apply)
 *   LOCAL != BASE, NEW == BASE → local edit, pack unchanged — retained drift
 *   LOCAL != BASE, NEW != BASE → conflict (refuse; --theirs/--keep-local)
 *
 * Install's `classify` cannot make these calls: it treats "has our marker,
 * content differs" as safe-to-overwrite (right for install, wrong for update)
 * and markerless pack-owned files (skills, agentpack.json) as conflicts
 * (ownership lives in the manifest hash, not a marker).
 */

import * as fs from "node:fs/promises";
import type { AdapterOutputFile, AtomType } from "../schema/types.js";
import type { InstallManifestV1, InstallPlanV2, HistoryActor } from "./types.js";
import { resolveAgentpackPaths, fromRelative, realpathContained } from "./paths.js";
import { normalizeForHash, sha256Hex } from "./checksum.js";
import {
  extractMarkerSpan,
  removeMarkerSpan,
  removeJsonFragment,
  jsonFragmentIntact,
} from "./merge.js";
import { applyInstall, type ApplyInstallResult } from "./apply.js";

export interface PlanUpdateOptions {
  /** Fresh `planInstall` of the NEW pack version against the project. */
  newPlan: InstallPlanV2;
  /** The install manifest recorded when the pack was last installed/updated. */
  priorManifest: InstallManifestV1;
}

export interface UpdateConflict {
  path: string;
  /**
   * both-changed: user edited BASE content AND upstream moved it.
   * foreign-file: on-disk file was never ours (no BASE record, no marker).
   * other-pack: file carries another pack's marker.
   * json-collision: JSON merge cannot reconcile.
   */
  reason: "both-changed" | "foreign-file" | "other-pack" | "json-collision";
  file: AdapterOutputFile;
}

export interface UpdateRemoval {
  path: string;
  /** Merge strategy recorded at install time; absent = whole-file removal. */
  strategy?: "marker" | "json";
}

export interface UpdatePlan {
  packId: string;
  fromVersion: string;
  toVersion: string;
  newPlan: InstallPlanV2;
  priorManifest: InstallManifestV1;
  /** Files to write: LOCAL == BASE (or new upstream files). Paths only; the
   * staged content lives in `writeFiles`. */
  cleanUpdates: string[];
  /** Staged file objects for every clean update (subset of newPlan files). */
  writeFiles: AdapterOutputFile[];
  /** User-edited files whose upstream content did not move — left alone. */
  retainedDrift: string[];
  /** Both sides moved (or foreign/other-pack files) — refuse by default. */
  conflicts: UpdateConflict[];
  /** BASE outputs absent from NEW — surgically removed at apply time. */
  removals: UpdateRemoval[];
}

export class UpdateConflictError extends Error {
  constructor(public conflicts: UpdateConflict[]) {
    super(
      `Update refused: ${conflicts.length} conflict(s) — the local file and the new pack version both changed:\n${conflicts
        .map((c) => `  • ${c.path} (${c.reason})`)
        .join(
          "\n",
        )}\nResolve with --theirs <glob> (take the pack's version; local edit is backed up) or --keep-local <glob> (keep the local edit, skip updating that path).`,
    );
    this.name = "UpdateConflictError";
  }
}

/** Reconcile the NEW plan against BASE knowledge from the prior manifest. */
export async function planUpdate(opts: PlanUpdateOptions): Promise<UpdatePlan> {
  const { newPlan, priorManifest } = opts;
  const ws = await resolveAgentpackPaths(newPlan.projectRoot);

  const baseHashByPath = new Map<string, string>(
    [...priorManifest.created, ...priorManifest.modified].map((e) => [e.path, e.sha256]),
  );
  const baseMergeByPath = new Map((priorManifest.merges ?? []).map((m) => [m.path, m]));
  const newMergeByPath = new Map(newPlan.merges.map((m) => [m.path, m]));

  const cleanUpdates: string[] = [];
  const writeFiles: AdapterOutputFile[] = [];
  const retainedDrift: string[] = [];
  const conflicts: UpdateConflict[] = [];

  const markClean = (f: AdapterOutputFile) => {
    cleanUpdates.push(f.path);
    writeFiles.push(f);
  };

  // New upstream files (no existing file on disk) always apply.
  for (const f of newPlan.created) {
    markClean(f);
  }

  for (const f of newPlan.modified) {
    const cls = await classifyAgainstBase({
      projectRoot: ws.projectRoot,
      file: f,
      packId: newPlan.packId,
      baseHash: baseHashByPath.get(f.path),
      baseMerge: baseMergeByPath.get(f.path),
      newMerge: newMergeByPath.get(f.path),
      // planInstall already vetted these as ours (marker match or merge).
      foreignWithoutBase: false,
    });
    if (cls === "clean") markClean(f);
    else if (cls === "retained") retainedDrift.push(f.path);
    else conflicts.push({ path: f.path, reason: cls, file: f });
  }

  // Install-level conflicts get a second chance: a markerless file the prior
  // manifest owns (skills, agentpack.json) is OURS even though classify saw
  // "no marker + content differs".
  for (const c of newPlan.conflicts) {
    if (c.reason === "other-pack-marker") {
      conflicts.push({ path: c.file.path, reason: "other-pack", file: c.file });
      continue;
    }
    if (c.reason === "json-collision") {
      conflicts.push({ path: c.file.path, reason: "json-collision", file: c.file });
      continue;
    }
    const cls = await classifyAgainstBase({
      projectRoot: ws.projectRoot,
      file: c.file,
      packId: newPlan.packId,
      baseHash: baseHashByPath.get(c.file.path),
      baseMerge: baseMergeByPath.get(c.file.path),
      newMerge: newMergeByPath.get(c.file.path),
      foreignWithoutBase: true,
    });
    if (cls === "clean") markClean(c.file);
    else if (cls === "retained") retainedDrift.push(c.file.path);
    else conflicts.push({ path: c.file.path, reason: cls, file: c.file });
  }

  // Removals: every BASE output absent from the NEW plan entirely. The
  // manifest (not the committed lockfile) is the source of truth (§0).
  const newPaths = new Set<string>([
    ...newPlan.created.map((f) => f.path),
    ...newPlan.modified.map((f) => f.path),
    ...newPlan.unchanged.map((f) => f.path),
    ...newPlan.conflicts.map((c) => c.file.path),
  ]);
  const removals: UpdateRemoval[] = [];
  for (const [p] of baseHashByPath) {
    if (newPaths.has(p)) continue;
    const merge = baseMergeByPath.get(p);
    removals.push(merge ? { path: p, strategy: merge.strategy } : { path: p });
  }

  return {
    packId: newPlan.packId,
    fromVersion: priorManifest.packVersion,
    toVersion: newPlan.packVersion,
    newPlan,
    priorManifest,
    cleanUpdates,
    writeFiles,
    retainedDrift,
    conflicts,
    removals,
  };
}

type BaseClassification = "clean" | "retained" | UpdateConflict["reason"];

async function classifyAgainstBase(input: {
  projectRoot: string;
  file: AdapterOutputFile;
  packId: string;
  baseHash: string | undefined;
  baseMerge:
    { strategy: "marker" | "json"; fragment: string; fragmentSha256: string } | undefined;
  newMerge: { fragmentSha256: string } | undefined;
  foreignWithoutBase: boolean;
}): Promise<BaseClassification> {
  const abs = fromRelative(input.projectRoot, input.file.path);
  let local: string;
  try {
    local = await fs.readFile(abs, "utf8");
  } catch {
    // Disappeared between plan and reconcile — writing recreates it.
    return "clean";
  }

  // Merge-managed file: BASE comparison runs on the pack's FRAGMENT, so user
  // content around the span never conflicts by construction (§1.3).
  if (input.baseMerge) {
    const newFragmentChanged =
      input.newMerge !== undefined &&
      input.newMerge.fragmentSha256 !== input.baseMerge.fragmentSha256;
    let localFragmentIntact: boolean;
    if (input.baseMerge.strategy === "marker") {
      const span = extractMarkerSpan(local, input.packId);
      localFragmentIntact =
        span !== null &&
        sha256Hex(normalizeForHash(`${span.span}\n`)) === input.baseMerge.fragmentSha256;
    } else {
      localFragmentIntact = jsonFragmentIntact(local, input.baseMerge.fragment);
    }
    if (localFragmentIntact) return "clean";
    if (!newFragmentChanged) return "retained";
    return "both-changed";
  }

  // Whole-file: ownership by manifest hash.
  const localSha = sha256Hex(normalizeForHash(local));
  if (input.baseHash === undefined) {
    // No BASE record. planInstall's own classification decides: a marker
    // match (modified) is ours; a markerless conflict is a foreign file.
    return input.foreignWithoutBase ? "foreign-file" : "clean";
  }
  if (localSha === input.baseHash) return "clean";
  const newSha = sha256Hex(
    normalizeForHash(
      input.file.content.endsWith("\n") ? input.file.content : `${input.file.content}\n`,
    ),
  );
  if (newSha === input.baseHash) return "retained";
  return "both-changed";
}

export interface ApplyUpdateOptions {
  update: UpdatePlan;
  /**
   * Per-path conflict resolutions. `theirs` — write the pack's new content
   * (the local edit is backed up first). `keepLocal` — keep the local edit
   * and skip that path. An unresolved conflict throws UpdateConflictError.
   */
  resolutions?: {
    theirs?: (path: string) => boolean;
    keepLocal?: (path: string) => boolean;
  };
  actor?: HistoryActor;
}

export interface ApplyUpdateResult extends ApplyInstallResult {
  /** Project-relative paths removed (upstream-deleted atom outputs). */
  removed: string[];
  /** Removal targets skipped because the user edited them since install. */
  skippedRemovals: string[];
  /** Paths kept local (retained drift + --keep-local resolutions). */
  retained: string[];
}

/**
 * Apply an update plan with install-grade discipline: WAL update_begin →
 * backups → atomic writes → surgical removals → lockfile + manifest →
 * update_commit. Interrupted updates are covered by the same recovery sweep
 * as installs.
 */
export async function applyUpdate(opts: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  const up = opts.update;
  const theirs = opts.resolutions?.theirs ?? (() => false);
  const keepLocal = opts.resolutions?.keepLocal ?? (() => false);

  const resolvedWrites: AdapterOutputFile[] = [...up.writeFiles];
  const retained: string[] = [...up.retainedDrift];
  const unresolved: UpdateConflict[] = [];
  for (const c of up.conflicts) {
    if (keepLocal(c.path)) retained.push(c.path);
    else if (theirs(c.path)) resolvedWrites.push(c.file);
    else unresolved.push(c);
  }
  if (unresolved.length > 0) {
    throw new UpdateConflictError(unresolved);
  }

  const ws = await resolveAgentpackPaths(up.newPlan.projectRoot);

  // Scan removals BEFORE any mutation: decide per path whether the removal is
  // safe (BASE-intact) or must be skipped (user-edited). Same posture as
  // uninstall — a refused/skip decision touches zero files.
  const removalActions: Array<
    | { kind: "unlink"; path: string }
    | { kind: "write"; path: string; content: string }
    | { kind: "restore"; path: string; backupPath: string }
  > = [];
  const skippedRemovals: string[] = [];
  const baseHashByPath = new Map<string, string>(
    [...up.priorManifest.created, ...up.priorManifest.modified].map((e) => [
      e.path,
      e.sha256,
    ]),
  );
  const priorModified = new Set(up.priorManifest.modified.map((m) => m.path));
  for (const removal of up.removals) {
    let abs: string;
    try {
      abs = fromRelative(ws.projectRoot, removal.path);
      await realpathContained(ws.projectRoot, abs);
    } catch {
      skippedRemovals.push(removal.path);
      continue;
    }
    let current: string;
    try {
      current = await fs.readFile(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // already gone
      throw err;
    }
    const currentSha = sha256Hex(normalizeForHash(current));
    const merge = (up.priorManifest.merges ?? []).find((m) => m.path === removal.path);
    if (merge?.strategy === "marker") {
      const span = extractMarkerSpan(current, up.packId);
      if (!span) continue; // our span already gone
      const intact = sha256Hex(normalizeForHash(`${span.span}\n`)) === merge.fragmentSha256;
      if (!intact) {
        skippedRemovals.push(removal.path);
        continue;
      }
      const remainder = removeMarkerSpan(current, up.packId);
      if (remainder === null) continue;
      if (remainder === "" && !priorModified.has(removal.path)) {
        removalActions.push({ kind: "unlink", path: removal.path });
      } else {
        removalActions.push({ kind: "write", path: removal.path, content: remainder });
      }
      continue;
    }
    if (merge?.strategy === "json") {
      if (!jsonFragmentIntact(current, merge.fragment)) {
        skippedRemovals.push(removal.path);
        continue;
      }
      const remainder = removeJsonFragment(current, merge.fragment);
      if (remainder === null) {
        skippedRemovals.push(removal.path);
        continue;
      }
      if (remainder === "" && !priorModified.has(removal.path)) {
        removalActions.push({ kind: "unlink", path: removal.path });
      } else {
        removalActions.push({
          kind: "write",
          path: removal.path,
          content: remainder === "" ? "{}\n" : remainder,
        });
      }
      continue;
    }
    // Whole file.
    if (currentSha !== baseHashByPath.get(removal.path)) {
      skippedRemovals.push(removal.path);
      continue;
    }
    if (priorModified.has(removal.path)) {
      // The install overwrote a pre-existing user file; give it back.
      const b = up.priorManifest.backups.find((bk) => bk.original === removal.path);
      if (b) {
        removalActions.push({
          kind: "restore",
          path: removal.path,
          backupPath: b.backupPath,
        });
        continue;
      }
    }
    removalActions.push({ kind: "unlink", path: removal.path });
  }

  // Build the filtered install plan: only resolved writes are applied; the
  // retained paths are carried forward from the prior manifest.
  const writePaths = new Set(resolvedWrites.map((f) => f.path));
  const createdPaths = new Set(up.newPlan.created.map((f) => f.path));
  const filteredPlan: InstallPlanV2 = {
    ...up.newPlan,
    created: up.newPlan.created.filter((f) => writePaths.has(f.path)),
    modified: resolvedWrites.filter((f) => !createdPaths.has(f.path)),
    conflicts: [],
    merges: up.newPlan.merges.filter((m) => writePaths.has(m.path)),
  };

  const result = await applyInstall({
    plan: filteredPlan,
    actor: opts.actor ?? { type: "cli" },
    updateMode: {
      previousPackVersion: up.fromVersion,
      removalActions,
      carryForward: retained,
      priorManifest: up.priorManifest,
    },
  });

  return {
    ...result,
    removed: removalActions.map((a) => a.path),
    skippedRemovals,
    retained,
  };
}

/**
 * Exec re-consent delta (§4 rule 2). The lockfile's atom entries collapse to
 * a synthetic `*pack` atom, so per-atom sourceChecksum diffing is not
 * possible; instead the gate keys off (a) exec atom ids added since the prior
 * manifest and (b) written/removed files that ARE exec surfaces — which is
 * file-precise and at least as strict as the design's atom-checksum rule.
 */
export function computeExecDelta(input: {
  priorManifest: InstallManifestV1;
  atomTypes: Array<{ id: string; type: AtomType }>;
  writtenPaths: string[];
  removedPaths: string[];
  /** Staged content for written paths (bang-bash detection). */
  writtenContents: Map<string, string>;
}): { addedExecAtoms: string[]; execSurfaceWrites: string[] } {
  const priorAtomIds = new Set(input.priorManifest.atomIds);
  const execAtoms = input.atomTypes.filter(
    (a) => a.type === "hook" || a.type === "mcp_server",
  );
  const addedExecAtoms = execAtoms.filter((a) => !priorAtomIds.has(a.id)).map((a) => a.id);

  const shipsHooks = execAtoms.some((a) => a.type === "hook");
  const BANG_BASH = /!`/;
  // User-scope installs (sync S3) drop the `.claude/` prefix: hooks live at
  // `hooks/`, settings at `settings.json`, commands/agents at the root. Keyed
  // off the manifest's recorded scope so project-scope packs emitting a
  // top-level `hooks/` dir for some other target don't false-positive.
  const userScope = input.priorManifest.scope === "user";
  const isExecSurface = (p: string, content?: string): boolean => {
    if (/(^|\/)\.claude\/hooks\//.test(p)) return true;
    if (userScope && /^hooks\//.test(p)) return true;
    if (userScope && p === "settings.json" && shipsHooks) return true;
    if (
      userScope &&
      /^(commands|agents)\/[^/]+\.md$/.test(p) &&
      content !== undefined &&
      BANG_BASH.test(content)
    ) {
      return true;
    }
    // Config surfaces carrying launch/command lines: MCP server configs and
    // the codex config.toml where the codex adapter writes MCP command lines
    // (security review, sync S2 — a changed codex MCP command must re-consent).
    if (
      /(^|\/)(\.mcp\.json|\.cursor\/mcp\.json|\.codex\/hooks\.json|\.codex\/config\.toml)$/.test(
        p,
      )
    ) {
      return true;
    }
    // Hooks live inside settings.json — a settings write only counts as an
    // exec surface when the pack actually ships hook atoms.
    if (/(^|\/)\.claude\/settings\.json$/.test(p) && shipsHooks) return true;
    if (
      /(^|\/)\.claude\/(commands|agents)\/[^/]+\.md$/.test(p) &&
      content !== undefined &&
      BANG_BASH.test(content)
    ) {
      return true;
    }
    return false;
  };

  const execSurfaceWrites: string[] = [];
  for (const p of input.writtenPaths) {
    if (isExecSurface(p, input.writtenContents.get(p))) execSurfaceWrites.push(p);
  }
  for (const p of input.removedPaths) {
    if (isExecSurface(p)) execSurfaceWrites.push(p);
  }
  return { addedExecAtoms, execSurfaceWrites };
}
