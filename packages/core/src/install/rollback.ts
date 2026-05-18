import type { HistoryEntryV1 } from "./types.js";
import { resolveWorkgraphPaths } from "./paths.js";
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
}

/**
 * Roll the project back to the state immediately AFTER the entry with
 * id=`to`. Concretely: for every install_commit entry newer than `to` that
 * has not already been uninstalled, run `uninstall(packId)`. Refuses to
 * cascade through later installs of the same pack unless `--cascade`.
 */
export async function rollback(opts: RollbackOptions): Promise<RollbackResult> {
  const ws = await resolveWorkgraphPaths(opts.projectRoot);
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
      throw new Error(
        "No install_commit entries in history — nothing to roll back to.",
      );
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

  // Order: newest first. Uninstall each.
  const undone: HistoryEntryV1[] = [];
  const uninstalledPacks: string[] = [];
  for (let i = slice.length - 1; i >= 0; i--) {
    const e = slice[i];
    if (e === undefined) continue;
    if (e.action !== "install_commit") continue;
    // If --packId scoped, skip unrelated.
    if (opts.packId && e.packId !== opts.packId) continue;
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
  };
}
