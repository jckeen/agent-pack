import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InstallManifestV1 } from "./types.js";
import type { WorkgraphPaths } from "./paths.js";
import {
  resolveWorkgraphPaths,
  fromRelative,
  realpathContained,
} from "./paths.js";
import { readInstallManifest, deleteInstallManifest } from "./manifest.js";
import { recordHistory, newHistoryId } from "./history.js";
import { normalizeForHash, sha256Hex } from "./checksum.js";

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
        .join("\n")}\nRe-run with --force to ignore user edits, or --force-restore to restore backups over user edits.`,
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
 *   3. Delete the install manifest at `.workgraph/installed/<packId>.json`.
 *   4. Append `uninstall` history entry.
 *
 * Files where the user has edited since install are surfaced as conflicts.
 * The lockfile (`AGENTPACK.lock`) at projectRoot is NOT deleted by this — the
 * user owns it; deleting on uninstall would erase audit history.
 */
export async function uninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const ws = await resolveWorkgraphPaths(opts.projectRoot);
  const manifest = await readInstallManifest(ws, opts.packId);

  const removed: string[] = [];
  const restored: string[] = [];
  const conflicts: UninstallResult["conflicts"] = [];

  // 1. Delete created files.
  for (const entry of manifest.created) {
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
        // File already gone — nothing to do.
        continue;
      }
      throw err;
    }
    const currentSha = sha256Hex(normalizeForHash(current));
    if (currentSha !== entry.sha256 && !opts.force) {
      conflicts.push({ path: entry.path, reason: "user-edited-after-install" });
      continue;
    }
    await fs.unlink(abs);
    removed.push(entry.path);
    // Best-effort cleanup of empty parent directories up to projectRoot. We
    // never recurse into directories we didn't create here, so this only
    // succeeds when the directory is empty.
    await pruneEmptyParents(ws.projectRoot, abs);
  }

  // 2. Restore backups.
  for (const b of manifest.backups) {
    const targetAbs = fromRelative(ws.projectRoot, b.original);
    let currentSha = "";
    try {
      const cur = await fs.readFile(targetAbs, "utf8");
      currentSha = sha256Hex(normalizeForHash(cur));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const expectedCur = manifest.modified.find((m) => m.path === b.original)?.sha256;
    if (
      expectedCur !== undefined &&
      currentSha !== "" &&
      currentSha !== expectedCur &&
      !opts.forceRestore
    ) {
      conflicts.push({ path: b.original, reason: "user-edited-after-install" });
      continue;
    }
    const backupAbs = fromRelative(ws.projectRoot, b.backupPath);
    const data = await fs.readFile(backupAbs, "utf8");
    await fs.mkdir(path.dirname(targetAbs), { recursive: true });
    await fs.writeFile(targetAbs, data, "utf8");
    restored.push(b.original);
  }

  if (conflicts.length > 0 && !opts.force && !opts.forceRestore) {
    throw new UninstallConflictError(conflicts);
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

async function pruneEmptyParents(
  projectRoot: string,
  startAbs: string,
): Promise<void> {
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
export { resolveWorkgraphPaths };
export type { InstallManifestV1, WorkgraphPaths };
