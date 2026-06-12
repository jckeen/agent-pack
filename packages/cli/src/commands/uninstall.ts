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
          yes: boolean;
          force: boolean;
          forceRestore: boolean;
        },
      ) => {
        try {
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
          console.log(pc.green(`  Remove (${manifest.created.length}):`));
          for (const c of manifest.created) console.log(pc.green(`    − ${c.path}`));
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
          console.log(
            pc.dim(
              `  • AGENTPACK.lock retained (still describes ${packId} for audit/history; the install footprint is gone). Re-install or delete it manually if you want it cleared.`,
            ),
          );
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
