import type { HistoryEntryV1 } from "./types.js";
import { resolveAgentpackPaths } from "./paths.js";
import { readHistory, recordHistory, newHistoryId } from "./history.js";
import { uninstall } from "./uninstall.js";

export interface RollbackOptions {
  /** History entry id to roll back to (exclusive — everything after is undone). */
  to?: string;
  /** Pack to roll back (default = last install). */
  packId?: string;
  projectRoot: string;
  /** Cascade past supersession (uninstall newer installs of the same pack). */
  cascade?: boolean;
  actor?: { type: "cli" | "ci" | "agent"; id?: string };
}

export interface RollbackResult {
  rolledBackTo: string;
  /** History entries (newest first) that this rollback undid. */
  undone: HistoryEntryV1[];
  /** Pack ids the rollback uninstalled. */
  uninstalledPacks: string[];
  /**
   * Pack ids whose install was undone as a no-op: the entry being rolled back
   * was an *idempotent re-install* (same version + profile) of a pack that was
   * already installed by an earlier, non-undone commit. Undoing it leaves the
   * pack installed at that identical prior state rather than removing it.
   */
  retainedPacks: string[];
}

/**
 * The install_commit that leaves `packId` net-installed at history index `idx`
 * (inclusive), or null if the pack is not installed at that point. Scans
 * install_commit (success) vs uninstall actions — rollback's own removals
 * record `uninstall` entries, so this also reflects prior rollbacks.
 */
function netInstalledAt(
  history: HistoryEntryV1[],
  idx: number,
  packId: string,
): HistoryEntryV1 | null {
  let active: HistoryEntryV1 | null = null;
  const end = Math.min(idx, history.length - 1);
  for (let i = 0; i <= end; i++) {
    const e = history[i];
    if (!e || e.packId !== packId) continue;
    if (e.action === "install_commit" && e.result !== "failed") active = e;
    else if (e.action === "uninstall") active = null;
  }
  return active;
}

/**
 * Roll the project back to the state immediately AFTER the entry with
 * id=`to`. Concretely: for every install_commit entry newer than `to` that
 * has not already been uninstalled, run `uninstall(packId)`.
 *
 * Two refusals protect against over-removal:
 *  - Multiple installs of the same pack inside the undo slice → cascade by
 *    nature; refused without `--cascade`.
 *  - Undoing a commit that *re-installed* a pack already installed by an
 *    earlier, non-undone commit. An identical re-install (same version +
 *    profile) is undone as a no-op, leaving the pack installed at its prior
 *    state; a version/profile-changing re-install is refused without
 *    `--cascade`, because local backups cannot reconstruct the prior version.
 */
export async function rollback(opts: RollbackOptions): Promise<RollbackResult> {
  const ws = await resolveAgentpackPaths(opts.projectRoot);
  const all = await readHistory(ws);
  if (all.length === 0) {
    throw new Error("No history found — nothing to roll back.");
  }

  // Figure out target index. If --to provided, find it. Otherwise pick the
  // index right before the last install_commit for `packId` (defaulting to
  // most-recent pack).
  let targetIdx: number;
  if (opts.to) {
    targetIdx = all.findIndex((e) => e.id === opts.to);
    if (targetIdx === -1) {
      throw new Error(`History entry not found: ${opts.to}`);
    }
  } else {
    const lastCommit = [...all].reverse().find((e) => e.action === "install_commit");
    if (!lastCommit) {
      throw new Error("No install_commit entries in history — nothing to roll back to.");
    }
    // We want to undo just this commit, so target is the index BEFORE it.
    targetIdx = all.indexOf(lastCommit) - 1;
    opts.packId ??= lastCommit.packId;
  }

  // Everything after targetIdx is the slice to undo.
  const slice = all.slice(targetIdx + 1);

  // Supersession check: across the slice, every pack should appear in at most
  // one install_commit entry — otherwise the rollback is cascading by nature.
  const installedInSlice = new Map<string, HistoryEntryV1>();
  for (const e of slice) {
    if (e.action === "install_commit") {
      if (installedInSlice.has(e.packId) && !opts.cascade) {
        throw new Error(
          `Cannot rollback past install ${e.id} of \`${e.packId}\`: superseded by a later install of the same pack. Pass --cascade to undo both.`,
        );
      }
      installedInSlice.set(e.packId, e);
    }
  }

  // Order: newest first. Uninstall each — unless undoing the commit would
  // remove a pack that an EARLIER, non-undone commit still owns (a re-install).
  const undone: HistoryEntryV1[] = [];
  const uninstalledPacks: string[] = [];
  const retainedPacks: string[] = [];
  const alreadyUndone: HistoryEntryV1[] = [];
  for (let i = slice.length - 1; i >= 0; i--) {
    const e = slice[i];
    if (e === undefined) continue;
    if (e.action !== "install_commit") continue;
    // If --packId scoped, skip unrelated.
    if (opts.packId && e.packId !== opts.packId) continue;

    // Already undone? If a later uninstall/rollback in (or after) the slice
    // already removed this install, there is nothing on disk to take out —
    // calling uninstall again would throw "No install manifest found". Skip
    // it so the rollback is honest instead of erroring on a phantom.
    if (!netInstalledAt(all, all.length - 1, e.packId)) {
      alreadyUndone.push(e);
      continue;
    }

    // Was this pack already installed before the slice? If so, `e` is a
    // re-install, and a full uninstall would over-remove (taking the earlier
    // install's footprint with it) — the documented contract is "restore to
    // the state before this entry", which for a re-install means "still
    // installed".
    const prior = netInstalledAt(all, targetIdx, e.packId);
    if (prior) {
      const idempotent = prior.packVersion === e.packVersion && prior.profile === e.profile;
      if (idempotent) {
        // Identical re-install: undoing it is a filesystem no-op. Leave the
        // pack installed at its (byte-identical) prior state.
        undone.push(e);
        retainedPacks.push(e.packId);
        continue;
      }
      if (!opts.cascade) {
        throw new Error(
          `Cannot roll back the re-install of \`${e.packId}\` (it changed ` +
            `${prior.packVersion}/${prior.profile} → ${e.packVersion}/${e.profile}). ` +
            `An earlier install remains and local backups cannot reconstruct the ` +
            `prior version. Re-install \`${prior.packVersion}\` (profile ` +
            `\`${prior.profile}\`) explicitly to go back, or pass --cascade to ` +
            `remove \`${e.packId}\` from the project entirely.`,
        );
      }
      // --cascade: the user explicitly wants the pack gone — fall through to a
      // full uninstall.
    }

    await uninstall({
      packId: e.packId,
      projectRoot: ws.projectRoot,
      force: true, // user opted into the rollback; treat conflicts as resolved
      forceRestore: true,
      actor: opts.actor,
    });
    undone.push(e);
    uninstalledPacks.push(e.packId);
  }

  // Nothing actionable: the only matching install_commit(s) were already
  // undone by a prior uninstall/rollback. Say so plainly instead of recording
  // a hollow "rolled back 0" success or erroring on a missing manifest.
  if (undone.length === 0 && retainedPacks.length === 0 && alreadyUndone.length > 0) {
    const packs = [...new Set(alreadyUndone.map((e) => e.packId))].join(", ");
    throw new Error(
      `Nothing to roll back: the most recent install of \`${packs}\` was ` +
        `already uninstalled. Use --to <historyId> to target a specific entry, ` +
        `or re-install the pack if you want it back.`,
    );
  }

  // Record the rollback.
  const anchor = all[targetIdx];
  await recordHistory(ws, {
    id: newHistoryId(),
    action: "rollback",
    timestamp: new Date().toISOString(),
    packId: opts.packId ?? "*",
    packVersion: anchor?.packVersion ?? "*",
    target: (anchor?.target ?? "generic") as HistoryEntryV1["target"],
    profile: anchor?.profile ?? "safe",
    rolledBackTo: opts.to ?? anchor?.id ?? "",
    actor: opts.actor ?? { type: "cli" },
    result: undone.length > 0 ? "success" : "partial",
  });

  return {
    rolledBackTo: opts.to ?? anchor?.id ?? "",
    undone,
    uninstalledPacks,
    retainedPacks,
  };
}
