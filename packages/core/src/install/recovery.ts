import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HistoryEntryV1 } from "./types.js";
import type { AgentpackPaths } from "./paths.js";
import { resolveAgentpackPaths, fromRelative, realpathContained } from "./paths.js";
import { readHistory, recordHistory, newHistoryId, verifyChain } from "./history.js";
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

  // The sweep drives unlink/restore from history entries, so a forged or
  // corrupted history (a repo can ship a committed `.agentpack/history.jsonl`)
  // must not reach that machinery. A genuine local WAL is always chain-valid;
  // refuse to act on a broken chain (security review, sync S2). `verify
  // --chain` surfaces the same break loudly to the user.
  const chain = verifyChain(all);
  if (!chain.ok) {
    throw new Error(
      `Refusing crash recovery: history.jsonl hash chain is broken at entry index ${chain.brokeAt}. ` +
        `Run \`agentpack verify --chain\` to inspect; a forged or corrupted history cannot drive recovery.`,
    );
  }

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
    // The packVersion must match the begin entry too (sync S2): an UPDATE
    // that crashes between file writes and the manifest write leaves the
    // PRIOR version's manifest on disk — same packId, stale records — which
    // would otherwise roll forward into an inconsistent state.
    let manifestPresent = false;
    if (allPresentAndClean && planned.length > 0) {
      try {
        const m = await readInstallManifest(ws, begin.packId);
        manifestPresent = m.packId === begin.packId && m.packVersion === begin.packVersion;
      } catch {
        manifestPresent = false;
      }
    }
    if (allPresentAndClean && manifestPresent && planned.length > 0) {
      // Roll forward: synthesize a commit entry matching the begin's kind.
      const committed = await recordHistory(ws, {
        id: newHistoryId(),
        action: begin.action === "update_begin" ? "update_commit" : "install_commit",
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
    } else if (planned.length > 0 || (begin.requiredBackups?.length ?? 0) > 0) {
      // Roll back: delete staged files, restore overwritten user files, append
      // a recovery entry whose result reflects whether the rollback was safe.
      // A removal-only update (sync S2) has empty plannedFiles but non-empty
      // requiredBackups — it must still roll back, restoring the removal
      // targets from their backups, rather than being left as "no planned
      // files — leave alone" (which stranded the mutated files).
      const createdSet = new Set(begin.createdPaths ?? []);
      for (const pf of planned) {
        let abs: string;
        try {
          abs = fromRelative(ws.projectRoot, pf.path);
          await realpathContained(ws.projectRoot, abs);
        } catch {
          // Path was malformed or escaped projectRoot — refuse to act.
          continue;
        }
        // Never follow a symlink at the destination — operate only on a real
        // file AgentPack itself wrote.
        let stat;
        try {
          stat = await fs.lstat(abs);
        } catch {
          continue; // Not present; nothing to do.
        }
        if (stat.isSymbolicLink()) continue;
        if (createdSet.has(pf.path)) {
          // A path AgentPack CREATED fresh: it did not pre-exist, so deleting
          // it can never destroy a user's file. Unlink unconditionally — a
          // partially-written create has a non-matching hash and the legacy
          // hash-match rule would otherwise strand it on disk (Finding 1).
          await fs.unlink(abs).catch(() => {});
          continue;
        }
        // Legacy path (begin entry has no createdPaths, or path not listed):
        // only delete when the hash matches what we planned to write, never a
        // user's pre-existing file.
        try {
          const raw = await fs.readFile(abs, "utf8");
          const sha = sha256Hex(normalizeForHash(raw));
          if (sha === pf.sha256) {
            await fs.unlink(abs).catch(() => {});
          }
        } catch {
          // Unreadable — leave it alone.
        }
      }
      // Restore any backed-up user files this install attempt overwrote.
      // Backups live under the project-relative dir the begin entry recorded;
      // the layout mirrors the project tree, so each file's path relative to
      // the backup root IS its original project-relative path. Restore only
      // into destinations the unlink pass above left empty — never clobber a
      // file the user has since recreated.
      // Update removals mutated pre-existing files that are NOT in
      // plannedFiles (they live only in requiredBackups). Those must be
      // force-restored over the crash-interrupted content; every other backup
      // keeps the create-only semantics that spare a user-recreated file.
      const plannedPaths = new Set(planned.map((pf) => pf.path));
      const forceRestore = new Set(
        (begin.requiredBackups ?? []).filter((p) => !plannedPaths.has(p)),
      );
      let restored = new Set<string>();
      if (begin.backupDir) {
        restored = await restoreBackups(ws, begin.backupDir, forceRestore).catch(() => {
          // A malformed backupDir must not crash the sweep; treat as "nothing
          // restored" and let the required-backup check below decide safety.
          return new Set<string>();
        });
      }
      // Data-loss guard (Finding 2): every required backup — a pre-existing
      // user file this install overwrote — must be back on disk. A required
      // path is satisfied if it was restored, OR no backup file exists for it
      // (the "modify demoted to create at apply-time" case: nothing was
      // overwritten, so there is nothing to lose). If a backup file IS present
      // but was not restored, the user's original is gone: fail loud rather
      // than record success.
      const unrestored = await unrestoredRequiredBackups(ws, begin, restored);
      if (unrestored.length > 0) {
        // Record the failure for audit, then leave the begin entry dangling so
        // a later sweep (after the operator fixes the backup dir) can retry.
        await recordHistory(ws, {
          id: newHistoryId(),
          action: "install_rollback_recovery",
          timestamp: new Date().toISOString(),
          packId: begin.packId,
          packVersion: begin.packVersion,
          target: begin.target,
          profile: begin.profile,
          actor: { type: "cli", id: "recovery" },
          result: "failed",
          error: `Could not restore overwritten user file(s): ${unrestored.join(", ")}`,
          recoveredBegin: begin.id,
        }).catch(() => {});
        result.unresolved.push(begin);
        continue;
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
 * not overwrite. Paths in `forceRestore` (update-removal targets) are the
 * exception: they are overwritten, since a write-/restore-kind removal left
 * crash-interrupted content on disk that create-only would skip.
 */
async function restoreBackups(
  ws: AgentpackPaths,
  backupDirRel: string,
  forceRestore: Set<string> = new Set(),
): Promise<Set<string>> {
  const restored = new Set<string>();
  const backupRoot = fromRelative(ws.projectRoot, backupDirRel);
  await realpathContained(ws.projectRoot, backupRoot);
  // The recorded dir must live under .agentpack/backups/ specifically — a
  // corrupted/forged WAL entry pointing at an arbitrary in-project directory
  // must not let the sweep "restore" non-backup content over project files
  // (codex re-review P2).
  const relToBackups = path.relative(ws.backupsDir, backupRoot);
  if (relToBackups.startsWith("..") || path.isAbsolute(relToBackups)) {
    return restored;
  }
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
          if (forceRestore.has(nextRel)) {
            // Update-removal targets (write-/restore-kind) left crash-
            // interrupted content on disk, so create-only would skip them —
            // overwrite to the pre-update backup (correctness review, S2).
            await fs.writeFile(dest, content, "utf8");
          } else {
            // Everything else: restore only if the destination is missing, so
            // a file the user recreated after the crash is never clobbered.
            await fs.writeFile(dest, content, { encoding: "utf8", flag: "wx" });
          }
          restored.add(nextRel);
        } catch {
          // Destination exists (non-force path) or unreadable backup — skip.
        }
      }
    }
  }
  await walk(backupRoot, "");
  return restored;
}

/**
 * Determine which of the begin entry's required backups (pre-existing user
 * files this install overwrote) are NOT safely back on disk after the restore
 * pass. A required path is data-loss ONLY if a backup file for it exists yet
 * the destination is now empty — meaning the user's original was overwritten
 * and could not be put back. It is safe when:
 *   - it was just restored, OR
 *   - the destination holds content (the user recreated it, or restore left
 *     existing content in place), OR
 *   - no backup file exists for it (the "modify demoted to create" case at
 *     apply-time: nothing was overwritten, so nothing is lost).
 *
 * Backward compatible: a begin entry without `requiredBackups` returns no
 * unrestored paths (legacy behavior — best-effort restore, no fail-loud).
 */
async function unrestoredRequiredBackups(
  ws: AgentpackPaths,
  begin: HistoryEntryV1,
  restored: Set<string>,
): Promise<string[]> {
  const required = begin.requiredBackups ?? [];
  if (required.length === 0) return [];
  const backupRoot = begin.backupDir
    ? fromRelative(ws.projectRoot, begin.backupDir)
    : undefined;
  // Whether the recorded backup root is itself present. If it is missing or
  // unreadable we cannot tell a "demoted create (no backup written)" apart
  // from "backup existed but was destroyed" by probing individual files — so
  // any required path whose dest is now empty must be treated as lost.
  let backupRootPresent = false;
  if (backupRoot !== undefined) {
    try {
      const st = await fs.stat(backupRoot);
      backupRootPresent = st.isDirectory();
    } catch {
      backupRootPresent = false;
    }
  }
  const unrestored: string[] = [];
  for (const rel of required) {
    if (restored.has(rel)) continue;
    let dest: string;
    try {
      dest = fromRelative(ws.projectRoot, rel);
      await realpathContained(ws.projectRoot, dest);
    } catch {
      // Path malformed/escaping — we never touched it, so nothing was lost.
      continue;
    }
    // Destination holds content (user-recreated, left in place, or a
    // force-restored removal target that landed in `restored` above) → safe.
    try {
      await fs.stat(dest);
      continue;
    } catch {
      // Destination missing — check whether a backup ever existed for it.
    }
    if (backupRoot === undefined || !backupRootPresent) {
      // The backup root is gone (or was never recorded) and the dest is empty:
      // an overwritten user file is unrecoverable. Fail loud.
      unrestored.push(rel);
      continue;
    }
    const backupFile = path.join(backupRoot, ...rel.split("/"));
    try {
      const st = await fs.lstat(backupFile);
      if (st.isFile()) {
        // A backup existed but the dest is empty — the original is lost.
        unrestored.push(rel);
      }
      // Symlink/dir at the backup path: not a real backup; treat as no loss.
    } catch {
      // Backup root present but no backup file for this path → nothing was
      // overwritten (modify demoted to create at apply-time). Safe.
    }
  }
  return unrestored;
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
    // Only a SUCCESSFUL commit (or a rollback-recovery) resolves a begin. The
    // apply catch-path writes a `result: "failed"` commit for audit; if that
    // counted as a match, a crashed apply would be hidden from every future
    // sweep and its partial state never cleaned up (correctness review, S2).
    // `install_rollback_recovery` is always terminal regardless of result.
    if (
      ((after.action === "install_commit" || after.action === "update_commit") &&
        after.result === "success") ||
      after.action === "install_rollback_recovery"
    ) {
      if (after.recoveredBegin) matchedBeginIds.add(after.recoveredBegin);
    }
  }
  // ALSO: a begin immediately followed by its commit (no recoveredBegin
  // needed) in the normal happy path. We match those by structural locality:
  // a commit whose previousEntryId equals the begin's id and whose
  // packId+target+profile match. Sync S2: update_begin/update_commit share
  // the WAL discipline, so the sweep treats them identically.
  const dangling: HistoryEntryV1[] = [];
  for (let i = 0; i < entries.length; i++) {
    const begin = entries[i];
    if (begin === undefined) continue;
    if (begin.action !== "install_begin" && begin.action !== "update_begin") continue;
    if (matchedBeginIds.has(begin.id)) continue;
    // Happy-path locality match: the very next entry is a same-pack commit.
    const commitAction =
      begin.action === "update_begin" ? "update_commit" : "install_commit";
    let happy = false;
    for (let j = i + 1; j < entries.length; j++) {
      const next = entries[j];
      if (next === undefined) continue;
      if (next.action !== commitAction) continue;
      if (
        // A `result: "failed"` commit (the apply catch-path's audit row) must
        // NOT resolve the begin — otherwise a crashed apply is hidden from the
        // sweep and its partial state never rolled back (correctness review).
        next.result === "success" &&
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
