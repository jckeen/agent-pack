import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HistoryEntryV1 } from "./types.js";
import type { AgentpackPaths } from "./paths.js";
import { resolveAgentpackPaths, fromRelative, realpathContained } from "./paths.js";
import { readHistory, recordHistory, newHistoryId } from "./history.js";
import { readInstallManifest } from "./manifest.js";
import { normalizeForHash, sha256Hex } from "./checksum.js";

export interface RecoveryResult {
  /** Number of dangling `install_begin` entries discovered. */
  found: number;
  /** Recoveries that completed successfully. */
  recovered: HistoryEntryV1[];
  /** Begin entries that were rolled back (staged files were partial). */
  rolledBack: HistoryEntryV1[];
  /** Begin entries we could not classify safely; left alone. */
  unresolved: HistoryEntryV1[];
}

/**
 * Sweep `.agentpack/history.jsonl` for `install_begin` entries that have no
 * matching `install_commit`. For each:
 *
 *   - If every plannedFiles[i].path exists with matching sha256 → roll forward
 *     (write `install_commit` so the install is durable).
 *   - If files are partial or hash-mismatched → roll back (delete staged
 *     files; append `install_rollback_recovery`).
 *
 * This is idempotent: re-running on a clean history is a no-op.
 */
export async function recoverIncomplete(projectRoot: string): Promise<RecoveryResult> {
  const ws = await resolveAgentpackPaths(projectRoot);
  const all = await readHistory(ws);
  const result: RecoveryResult = {
    found: 0,
    recovered: [],
    rolledBack: [],
    unresolved: [],
  };
  if (all.length === 0) return result;

  // Build a map: begin entries that have NO matching commit/recovery
  // afterward. Match is by packId + id ordering — a commit always comes after
  // its begin in the chain.
  const dangling = findDanglingBegins(all);
  result.found = dangling.length;

  for (const begin of dangling) {
    const planned = begin.plannedFiles ?? [];
    let allPresentAndClean = true;
    for (const pf of planned) {
      let abs: string;
      try {
        abs = fromRelative(ws.projectRoot, pf.path);
        // Defense-in-depth: a forged install_begin entry with attacker-chosen
        // plannedFiles[].path could point realpath to outside the project
        // (e.g. via a symlinked ancestor). Refuse before reading.
        await realpathContained(ws.projectRoot, abs);
      } catch {
        allPresentAndClean = false;
        break;
      }
      let raw: string;
      try {
        raw = await fs.readFile(abs, "utf8");
      } catch {
        allPresentAndClean = false;
        break;
      }
      const sha = sha256Hex(normalizeForHash(raw));
      if (sha !== pf.sha256) {
        allPresentAndClean = false;
        break;
      }
    }
    // Roll-forward additionally requires the install manifest to exist —
    // files-on-disk alone is not a durable install. A crash after the file
    // writes but before the manifest write would otherwise be marked
    // "success" while verify/uninstall/rollback cannot find the install
    // (codex P0-4). Manifest missing or unreadable → roll back.
    let manifestPresent = false;
    if (allPresentAndClean && planned.length > 0) {
      try {
        const m = await readInstallManifest(ws, begin.packId);
        manifestPresent = m.packId === begin.packId;
      } catch {
        manifestPresent = false;
      }
    }
    if (allPresentAndClean && manifestPresent && planned.length > 0) {
      // Roll forward: synthesize a commit entry.
      const committed = await recordHistory(ws, {
        id: newHistoryId(),
        action: "install_commit",
        timestamp: new Date().toISOString(),
        packId: begin.packId,
        packVersion: begin.packVersion,
        target: begin.target,
        profile: begin.profile,
        actor: { type: "cli", id: "recovery" },
        result: "success",
        recoveredBegin: begin.id,
      });
      result.recovered.push(committed);
    } else if (planned.length > 0) {
      // Roll back: delete staged files we recognize, append recovery entry.
      for (const pf of planned) {
        let abs: string;
        try {
          abs = fromRelative(ws.projectRoot, pf.path);
          await realpathContained(ws.projectRoot, abs);
        } catch {
          // Path was malformed or escaped projectRoot — refuse to act.
          continue;
        }
        try {
          const raw = await fs.readFile(abs, "utf8");
          const sha = sha256Hex(normalizeForHash(raw));
          // Only delete files whose hash matches what we planned to write —
          // never delete a user's pre-existing file.
          if (sha === pf.sha256) {
            await fs.unlink(abs).catch(() => {});
          }
        } catch {
          // File not present; nothing to do.
        }
      }
      // Restore any backed-up user files this install attempt overwrote.
      // Backups live under the project-relative dir the begin entry recorded;
      // the layout mirrors the project tree, so each file's path relative to
      // the backup root IS its original project-relative path. Restore only
      // into destinations the unlink pass above left empty — never clobber a
      // file the user has since recreated.
      if (begin.backupDir) {
        await restoreBackups(ws, begin.backupDir).catch(() => {
          // Best-effort: a malformed backupDir must not block the sweep.
        });
      }
      const rolled = await recordHistory(ws, {
        id: newHistoryId(),
        action: "install_rollback_recovery",
        timestamp: new Date().toISOString(),
        packId: begin.packId,
        packVersion: begin.packVersion,
        target: begin.target,
        profile: begin.profile,
        actor: { type: "cli", id: "recovery" },
        result: "success",
        recoveredBegin: begin.id,
      });
      result.rolledBack.push(rolled);
    } else {
      // No planned files — odd. Leave alone.
      result.unresolved.push(begin);
    }
  }

  return result;
}

/**
 * Walk a project-relative backup directory and copy every file back to its
 * original location (the path relative to the backup root). Restores only
 * when the destination is missing — the rollback unlink pass removes staged
 * files first, and anything else at the destination is user content we must
 * not overwrite.
 */
async function restoreBackups(ws: AgentpackPaths, backupDirRel: string): Promise<void> {
  const backupRoot = fromRelative(ws.projectRoot, backupDirRel);
  await realpathContained(ws.projectRoot, backupRoot);
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Backup dir missing — nothing to restore.
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, nextRel);
      } else if (entry.isFile()) {
        const dest = fromRelative(ws.projectRoot, nextRel);
        await realpathContained(ws.projectRoot, dest);
        try {
          const content = await fs.readFile(abs, "utf8");
          await fs.mkdir(path.dirname(dest), { recursive: true });
          // `wx`: restore only if the destination is missing.
          await fs.writeFile(dest, content, { encoding: "utf8", flag: "wx" });
        } catch {
          // Destination exists or unreadable backup — skip.
        }
      }
    }
  }
  await walk(backupRoot, "");
}

function findDanglingBegins(entries: readonly HistoryEntryV1[]): HistoryEntryV1[] {
  // An install_begin is "matched" only by a directly-pointing commit or
  // rollback-recovery. The previous "same packId + next install_commit"
  // heuristic was wrong: it falsely marked a genuinely-dangling begin as
  // resolved as soon as the user re-installed the same pack. See
  // code-simplifier finding #7.
  const matchedBeginIds = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const after = entries[i];
    if (after === undefined) continue;
    if (
      (after.action === "install_commit" || after.action === "install_rollback_recovery") &&
      after.recoveredBegin
    ) {
      matchedBeginIds.add(after.recoveredBegin);
    }
  }
  // ALSO: an install_begin immediately followed by install_commit (no
  // recoveredBegin needed) in the normal happy path. We match those by
  // structural locality: an install_commit whose previousEntryId equals the
  // begin's id and whose packId+target+profile match.
  const dangling: HistoryEntryV1[] = [];
  for (let i = 0; i < entries.length; i++) {
    const begin = entries[i];
    if (begin === undefined) continue;
    if (begin.action !== "install_begin") continue;
    if (matchedBeginIds.has(begin.id)) continue;
    // Happy-path locality match: the very next entry is a same-pack commit.
    let happy = false;
    for (let j = i + 1; j < entries.length; j++) {
      const next = entries[j];
      if (next === undefined) continue;
      if (next.action !== "install_commit") continue;
      if (
        next.previousEntryId === begin.id &&
        next.packId === begin.packId &&
        next.target === begin.target &&
        next.profile === begin.profile
      ) {
        happy = true;
      }
      break;
    }
    if (!happy) dangling.push(begin);
  }
  return dangling;
}

export { resolveAgentpackPaths };
export type { AgentpackPaths };
