import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InstallManifestV1 } from "./types.js";
import type { AgentpackPaths } from "./paths.js";
import { resolveAgentpackPaths, fromRelative, realpathContained } from "./paths.js";
import { readInstallManifest, deleteInstallManifest } from "./manifest.js";
import { recordHistory, newHistoryId } from "./history.js";
import { normalizeForHash, sha256Hex } from "./checksum.js";
import {
  extractMarkerSpan,
  removeMarkerSpan,
  removeJsonFragment,
  jsonFragmentIntact,
} from "./merge.js";

export interface UninstallOptions {
  packId: string;
  projectRoot: string;
  /**
   * If a created file's current on-disk content no longer matches the install
   * manifest, surface as a conflict and refuse — unless `force` is set.
   */
  force?: boolean;
  /**
   * If a modified file's backup target now differs from the user's current
   * file, refuse to restore — unless `forceRestore`.
   */
  forceRestore?: boolean;
  actor?: { type: "cli" | "ci" | "agent"; id?: string };
}

export interface UninstallResult {
  packId: string;
  /** Project-relative paths the uninstall removed (files we created). */
  removed: string[];
  /** Project-relative paths restored from backup. */
  restored: string[];
  /**
   * Project-relative paths where uninstall noticed user edits and (without
   * --force) refused to act. With --force, these are also removed/restored.
   */
  conflicts: Array<{ path: string; reason: "user-edited-after-install" }>;
}

export class UninstallConflictError extends Error {
  constructor(public conflicts: UninstallResult["conflicts"]) {
    super(
      `Uninstall conflicts on ${conflicts.length} file(s):\n${conflicts
        .map((c) => `  • ${c.path} (${c.reason})`)
        .join(
          "\n",
        )}\nRe-run with --force to ignore user edits, or --force-restore to restore backups over user edits.`,
    );
    this.name = "UninstallConflictError";
  }
}

/**
 * Uninstall a previously-installed pack. Reads the install manifest and:
 *
 *   1. For every `created[]` entry: delete the file IF its current sha256
 *      matches the manifest's recorded sha256 (proof we own it).
 *   2. For every `backups[]` entry: restore the backup over the current file
 *      IF the current file's sha256 matches the manifest's recorded `modified`
 *      sha256 (proof the user hasn't edited since).
 *   3. Delete the install manifest at `.agentpack/installed/<packId>.json`.
 *   4. Append `uninstall` history entry.
 *
 * Files where the user has edited since install are surfaced as conflicts.
 * The lockfile (`AGENTPACK.lock`) at projectRoot is NOT deleted by this — the
 * user owns it; deleting on uninstall would erase audit history.
 */
export async function uninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const ws = await resolveAgentpackPaths(opts.projectRoot);
  const manifest = await readInstallManifest(ws, opts.packId);

  const removed: string[] = [];
  const restored: string[] = [];
  const conflicts: UninstallResult["conflicts"] = [];
  const mergeByPath = new Map((manifest.merges ?? []).map((m) => [m.path, m]));

  // PHASE 1 — scan only. A refused uninstall must touch zero files, so every
  // conflict is discovered before any mutation (qa-lead P1-1).
  type Action =
    | { kind: "unlink"; abs: string; rel: string }
    | { kind: "write"; abs: string; rel: string; content: string }
    | { kind: "restore"; abs: string; rel: string; backupAbs: string };
  const actions: Action[] = [];
  const modifiedPaths = new Set(manifest.modified.map((m) => m.path));

  for (const entry of [...manifest.created, ...manifest.modified]) {
    const abs = fromRelative(ws.projectRoot, entry.path);
    try {
      await realpathContained(ws.projectRoot, abs);
    } catch {
      // Path now escapes (symlink replaced with one going elsewhere).
      // Refuse to follow.
      conflicts.push({ path: entry.path, reason: "user-edited-after-install" });
      continue;
    }
    let current: string;
    try {
      current = await fs.readFile(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue; // Already gone — nothing to do.
      }
      throw err;
    }
    const currentSha = sha256Hex(normalizeForHash(current));
    const merge = mergeByPath.get(entry.path);
    const isModified = modifiedPaths.has(entry.path);

    if (merge) {
      // Merged file: remove only the pack's contribution, never the user's
      // surrounding content. A backup is NOT restored over a merged file —
      // that would erase the user's post-install edits to their own sections.
      if (currentSha === entry.sha256 && !isModified) {
        // Fast path: file is exactly what we created — remove it whole.
        actions.push({ kind: "unlink", abs, rel: entry.path });
        continue;
      }
      if (merge.strategy === "marker") {
        const span = extractMarkerSpan(current, manifest.packId);
        if (!span) continue; // Our span already removed by the user.
        const spanIntact =
          sha256Hex(normalizeForHash(`${span.span}\n`)) === merge.fragmentSha256;
        if (!spanIntact && !opts.force) {
          conflicts.push({ path: entry.path, reason: "user-edited-after-install" });
          continue;
        }
        const remainder = removeMarkerSpan(current, manifest.packId);
        if (remainder === null) continue;
        if (remainder === "" && !isModified) {
          actions.push({ kind: "unlink", abs, rel: entry.path });
        } else {
          actions.push({ kind: "write", abs, rel: entry.path, content: remainder });
        }
        continue;
      }
      // strategy === "json"
      if (!jsonFragmentIntact(current, merge.fragment) && !opts.force) {
        conflicts.push({ path: entry.path, reason: "user-edited-after-install" });
        continue;
      }
      const remainder = removeJsonFragment(current, merge.fragment);
      if (remainder === null) {
        // Current content is no longer valid JSON — only act under force.
        if (!opts.force) {
          conflicts.push({ path: entry.path, reason: "user-edited-after-install" });
        }
        continue;
      }
      if (remainder === "" && !isModified) {
        actions.push({ kind: "unlink", abs, rel: entry.path });
      } else if (remainder === "") {
        actions.push({ kind: "write", abs, rel: entry.path, content: "{}\n" });
      } else {
        actions.push({ kind: "write", abs, rel: entry.path, content: remainder });
      }
      continue;
    }

    if (isModified) {
      // Whole-file overwrite with a backup: restore the backup.
      const b = manifest.backups.find((bk) => bk.original === entry.path);
      if (!b) continue;
      if (currentSha !== entry.sha256 && !opts.forceRestore) {
        conflicts.push({ path: entry.path, reason: "user-edited-after-install" });
        continue;
      }
      const backupAbs = fromRelative(ws.projectRoot, b.backupPath);
      actions.push({ kind: "restore", abs, rel: entry.path, backupAbs });
      continue;
    }

    // Plain created file.
    if (currentSha !== entry.sha256 && !opts.force) {
      conflicts.push({ path: entry.path, reason: "user-edited-after-install" });
      continue;
    }
    actions.push({ kind: "unlink", abs, rel: entry.path });
  }

  if (conflicts.length > 0 && !opts.force && !opts.forceRestore) {
    throw new UninstallConflictError(conflicts);
  }

  // PHASE 2 — act.
  for (const a of actions) {
    if (a.kind === "unlink") {
      await fs.unlink(a.abs);
      removed.push(a.rel);
      // Best-effort cleanup of empty parent directories up to projectRoot. We
      // never recurse into directories we didn't create here, so this only
      // succeeds when the directory is empty.
      await pruneEmptyParents(ws.projectRoot, a.abs);
    } else if (a.kind === "write") {
      await fs.writeFile(a.abs, a.content, "utf8");
      removed.push(a.rel);
    } else {
      const data = await fs.readFile(a.backupAbs, "utf8");
      await fs.mkdir(path.dirname(a.abs), { recursive: true });
      await fs.writeFile(a.abs, data, "utf8");
      restored.push(a.rel);
    }
  }

  // 3. Delete install manifest.
  await deleteInstallManifest(ws, opts.packId);

  // 4. History entry.
  await recordHistory(ws, {
    id: newHistoryId(),
    action: "uninstall",
    timestamp: new Date().toISOString(),
    packId: manifest.packId,
    packVersion: manifest.packVersion,
    target: manifest.target,
    profile: manifest.profile,
    actor: opts.actor ?? { type: "cli" },
    result: conflicts.length === 0 ? "success" : "partial",
    error:
      conflicts.length === 0
        ? undefined
        : `uninstalled with ${conflicts.length} conflict(s) under --force`,
  });

  return { packId: opts.packId, removed, restored, conflicts };
}

async function pruneEmptyParents(projectRoot: string, startAbs: string): Promise<void> {
  let cur = path.dirname(startAbs);
  while (cur !== projectRoot && cur.startsWith(projectRoot)) {
    try {
      const entries = await fs.readdir(cur);
      if (entries.length > 0) return;
      await fs.rmdir(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

// Re-export for the public surface.
export { resolveAgentpackPaths };
export type { InstallManifestV1, AgentpackPaths };
