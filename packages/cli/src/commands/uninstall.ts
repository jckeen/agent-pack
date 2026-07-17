import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import pc from "picocolors";
import {
  uninstall,
  UninstallConflictError,
  readInstallManifest,
  resolveAgentpackPaths,
} from "@agentpack/core";
import { failCleanly } from "../lib/error.js";
import { confirm } from "../lib/prompt.js";

export function registerUninstall(program: Command): void {
  program
    .command("uninstall <packId>")
    .description("Remove a previously-installed AgentPack from the project.")
    .option("--project <dir>", "target project directory", process.cwd())
    .option(
      "--scope <scope>",
      "uninstall scope: `project` (default) or `user` — user scope targets the ~/.claude install (sync S3)",
      "project",
    )
    .option("-y, --yes", "skip confirmation prompt", false)
    .option("--force", "remove created files even if the user has edited them", false)
    .option(
      "--force-restore",
      "restore backups even if the user has edited the file since install",
      false,
    )
    .action(
      async (
        packId: string,
        options: {
          project: string;
          scope: string;
          yes: boolean;
          force: boolean;
          forceRestore: boolean;
        },
        command: Command,
      ) => {
        try {
          if (options.scope !== "project" && options.scope !== "user") {
            console.error(
              pc.red(`Invalid --scope \`${options.scope}\`. Choose: project, user`),
            );
            process.exit(2);
          }
          // `--scope user` targets the ~/.claude install — the exit door for
          // `install --scope user` (#146), with the same project→~/.claude
          // mapping install/update use (sync S3).
          if (options.scope === "user") {
            if (command.getOptionValueSource("project") === "cli") {
              console.error(
                pc.red(
                  "✗ --project and --scope user are mutually exclusive — user scope always targets ~/.claude.",
                ),
              );
              process.exit(2);
            }
            options.project = path.join(os.homedir(), ".claude");
          }
          const ws = await resolveAgentpackPaths(options.project);
          const manifest = await readInstallManifest(ws, packId);
          console.log(
            pc.bold(
              `\nUninstall plan: ${manifest.packId}@${manifest.packVersion} (${manifest.target}, ${manifest.profile})`,
            ),
          );
          // Merged files (shared CLAUDE.md/AGENTS.md, JSON configs) are
          // surgically un-merged — only the pack's span/entries come out, the
          // user's surrounding content stays. They are NOT backup restores, so
          // show them separately or the "Restore (n)" count contradicts the
          // "0 restored" result (QA P2-2).
          const mergePaths = new Set((manifest.merges ?? []).map((m) => m.path));
          const restores = manifest.backups.filter((b) => !mergePaths.has(b.original));
          // A merged file lists ONLY under Unmerge — it also appears in
          // `created` when the pack introduced it, but its uninstall action is
          // the merge one (span/entry removal; whole-file only when nothing
          // else remains), and double-listing reads as removing it twice
          // (#149c).
          const removals = manifest.created.filter((c) => !mergePaths.has(c.path));
          console.log(pc.green(`  Remove (${removals.length}):`));
          for (const c of removals) console.log(pc.green(`    − ${c.path}`));
          if (manifest.merges && manifest.merges.length > 0) {
            console.log(pc.cyan(`  Unmerge (${manifest.merges.length}):`));
            for (const m of manifest.merges)
              console.log(pc.cyan(`    ✂ ${m.path} (${m.strategy})`));
          }
          console.log(pc.cyan(`  Restore (${restores.length}):`));
          for (const b of restores) console.log(pc.cyan(`    ↺ ${b.original}`));

          if (!options.yes) {
            const ok = await confirm(pc.bold(`\nProceed with uninstall? [y/N] `));
            if (!ok) {
              console.log(pc.dim("Aborted."));
              process.exit(1);
            }
          }

          const result = await uninstall({
            packId,
            projectRoot: options.project,
            force: options.force,
            forceRestore: options.forceRestore,
          });
          console.log(pc.green(`\n✓ Uninstalled ${packId}.`));
          console.log(
            pc.dim(
              `  • ${result.removed.length} removed, ${result.restored.length} restored, ${result.conflicts.length} conflicts.`,
            ),
          );
          // Lockfile v2 (#114): uninstall removes only this pack's entry.
          const lockNote = {
            "entry-removed": `AGENTPACK.lock updated (${packId} entry removed; other packs' entries retained).`,
            "file-removed": `AGENTPACK.lock removed (${packId} was the last installed pack; history.jsonl keeps the audit trail).`,
            "not-tracked": `AGENTPACK.lock untouched (no entry for ${packId}).`,
            "unrecognized-left-in-place": `AGENTPACK.lock could not be parsed — left in place; inspect or delete it manually.`,
          }[result.lockfile];
          console.log(pc.dim(`  • ${lockNote}`));
        } catch (err) {
          if (err instanceof UninstallConflictError) {
            console.error(pc.red("✗ ") + err.message);
            process.exit(2);
          }
          failCleanly(err);
        }
      },
    );
}
