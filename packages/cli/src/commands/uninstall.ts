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
    .option(
      "--force",
      "remove created files even if the user has edited them",
      false,
    )
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
          console.log(pc.green(`  Remove (${manifest.created.length}):`));
          for (const c of manifest.created) console.log(pc.green(`    − ${c.path}`));
          console.log(pc.cyan(`  Restore (${manifest.backups.length}):`));
          for (const b of manifest.backups) console.log(pc.cyan(`    ↺ ${b.original}`));

          if (!options.yes) {
            const ok = await confirm(
              pc.bold(`\nProceed with uninstall? [y/N] `),
            );
            if (!ok) {
              console.log(pc.dim("Aborted."));
              process.exit(0);
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

