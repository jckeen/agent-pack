import * as fs from "node:fs/promises";
import type { HistoryEntryV1 } from "./types.js";
import type { WorkgraphPaths } from "./paths.js";
import { resolveWorkgraphPaths, fromRelative, realpathContained } from "./paths.js";
import { readHistory, recordHistory, newHistoryId } from "./history.js";
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
 * Sweep `.workgraph/history.jsonl` for `install_begin` entries that have no
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
  const ws = await resolveWorkgraphPaths(projectRoot);
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
    if (allPresentAndClean && planned.length > 0) {
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
      (after.action === "install_commit" ||
        after.action === "install_rollback_recovery") &&
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

export { resolveWorkgraphPaths };
export type { WorkgraphPaths };
