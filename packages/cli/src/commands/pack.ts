import type { Command } from "commander";
import pc from "picocolors";
import ora from "ora";
import { exportPack, type TargetPlatform } from "@workgraph/core";
import { renderInstallPlan } from "../lib/render.js";

const VALID_TARGETS: TargetPlatform[] = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
];

export function registerPack(program: Command): void {
  const pack = program
    .command("pack")
    .description("Pack-level operations (export, lock, etc.).");

  pack
    .command("export [path]")
    .description("Compile an AgentPack to platform-native files and write them to --out.")
    .option("--target <target>", "platform target", "claude-code")
    .option("--profile <profile>", "install profile")
    .option("--out <dir>", "output directory", "dist")
    .option("--only <atomIds>", "comma-separated subset of atom ids to include")
    .option("--no-strict", "do not abort on validation errors")
    .action(
      async (
        target: string | undefined,
        options: {
          target: TargetPlatform;
          profile?: string;
          out: string;
          only?: string;
          strict?: boolean;
        },
      ) => {
        if (!VALID_TARGETS.includes(options.target)) {
          console.error(
            pc.red(
              `Invalid --target \`${options.target}\`. Choose one of: ${VALID_TARGETS.join(", ")}`,
            ),
          );
          process.exit(2);
        }
        const source = target ?? process.cwd();
        const spinner = ora(`Exporting ${source} → ${options.target}`).start();
        try {
          const result = await exportPack({
            source,
            target: options.target,
            profile: options.profile,
            outDir: options.out,
            strict: options.strict ?? true,
            onlyAtoms: options.only?.split(",").map((s) => s.trim()).filter(Boolean),
          });
          spinner.succeed(
            `Wrote ${result.writtenFiles.length} file(s) to ${pc.cyan(result.outDir)}`,
          );
          console.log("");
          console.log(renderInstallPlan(result.plan));
          console.log("");
          console.log(pc.dim(`outDir: ${result.outDir}`));
        } catch (err) {
          spinner.fail(`Export failed: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );
}
