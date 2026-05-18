import type { Command } from "commander";
import pc from "picocolors";
import { verifyInstall } from "@workgraph/core";
import { failCleanly } from "../lib/error.js";

export function registerVerify(program: Command): void {
  program
    .command("verify <packId>")
    .description(
      "Verify that installed files still match the lockfile (drift detection).",
    )
    .option("--project <dir>", "target project directory", process.cwd())
    .option("--chain", "also verify the history.jsonl hash chain", false)
    .action(
      async (
        packId: string,
        options: { project: string; chain: boolean },
      ) => {
        try {
          const result = await verifyInstall({
            packId,
            projectRoot: options.project,
            checkChain: options.chain,
          });
          if (result.clean && result.chainOk !== false) {
            console.log(pc.green(`✓ ${packId} clean — no drift.`));
            if (options.chain) {
              console.log(pc.dim("  • History chain integrity: ok."));
            }
            process.exit(0);
          }
          if (result.chainOk === false) {
            console.error(
              pc.red(
                `✗ history.jsonl chain integrity FAILED at entry index ${result.chainBrokeAt}.`,
              ),
            );
            process.exit(3);
          }
          console.error(pc.red(`✗ ${packId} has drift:`));
          for (const d of result.drift) {
            console.error(
              `  ${pc.red("•")} ${d.path}: expected ${d.expected.slice(0, 12)}…, actual ${d.actual.slice(0, 12)}…`,
            );
          }
          for (const m of result.missing) {
            console.error(`  ${pc.red("•")} ${m}: missing`);
          }
          process.exit(2);
        } catch (err) {
          failCleanly(err);
        }
      },
    );
}
