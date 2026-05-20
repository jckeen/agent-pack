import type { Command } from "commander";
import pc from "picocolors";
import { rollback } from "@agentpack/core";
import { failCleanly } from "../lib/error.js";
import { confirm } from "../lib/prompt.js";

export function registerRollback(program: Command): void {
  program
    .command("rollback [historyId]")
    .description(
      "Undo the most recent install, or roll back to a specific history entry id with --to.",
    )
    .option("--project <dir>", "target project directory", process.cwd())
    .option("--to <historyId>", "roll back through this entry (exclusive)")
    .option("--pack <packId>", "limit rollback to this pack")
    .option("--cascade", "allow rollback to undo superseded installs", false)
    .option("-y, --yes", "skip confirmation prompt", false)
    .action(
      async (
        historyId: string | undefined,
        options: {
          project: string;
          to?: string;
          pack?: string;
          cascade: boolean;
          yes: boolean;
        },
      ) => {
        try {
          const target = options.to ?? historyId;
          if (!options.yes) {
            const ok = await confirm(
              pc.bold(
                `\nRoll back ${target ? `to ${target}` : "the most recent install"} in ${options.project}? [y/N] `,
              ),
            );
            if (!ok) {
              console.log(pc.dim("Aborted."));
              process.exit(0);
            }
          }
          const result = await rollback({
            to: target,
            packId: options.pack,
            projectRoot: options.project,
            cascade: options.cascade,
          });
          console.log(pc.green(`\n✓ Rolled back ${result.undone.length} install(s).`));
          for (const e of result.undone) {
            console.log(pc.dim(`  • ${e.packId}@${e.packVersion} ${e.id}`));
          }
          if (result.rolledBackTo) {
            console.log(pc.dim(`  ↩ Anchor: ${result.rolledBackTo}`));
          }
        } catch (err) {
          failCleanly(err);
        }
      },
    );
}

