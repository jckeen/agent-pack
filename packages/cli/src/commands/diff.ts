import type { Command } from "commander";
import pc from "picocolors";
import {
  planInstall,
  diffPlan,
  type TargetPlatform,
} from "@agentpack/core";
import { failCleanly } from "../lib/error.js";
import { CLI_VERSION } from "../lib/version.js";

const VALID_TARGETS: TargetPlatform[] = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
];

export function registerDiff(program: Command): void {
  program
    .command("diff [pack]")
    .description("Print a unified diff between current project files and what `install` would write.")
    .option("--target <target>", "platform target", "claude-code")
    .option("--profile <profile>", "install profile", "safe")
    .option("--project <dir>", "target project directory", process.cwd())
    .action(
      async (
        pack: string | undefined,
        options: { target: TargetPlatform; profile: string; project: string },
      ) => {
        try {
          if (!VALID_TARGETS.includes(options.target)) {
            console.error(
              pc.red(
                `Invalid --target \`${options.target}\`. Choose one of: ${VALID_TARGETS.join(", ")}`,
              ),
            );
            process.exit(2);
          }
          const source = pack ?? process.cwd();
          const plan = await planInstall({
            source,
            target: options.target,
            profile: options.profile,
            projectRoot: options.project,
            generator: { cli: CLI_VERSION, adapter: CLI_VERSION },
          });
          const diffs = await diffPlan(plan);
          for (const d of diffs) {
            const tag =
              d.status === "create"
                ? pc.green("[create]")
                : d.status === "modify"
                  ? pc.cyan("[modify]")
                  : d.status === "unchanged"
                    ? pc.dim("[unchanged]")
                    : pc.red(`[conflict: ${d.conflict?.reason ?? "?"}]`);
            console.log(`${tag} ${d.path}`);
            if (d.diff) {
              console.log(colorDiff(d.diff));
            }
          }
        } catch (err) {
          failCleanly(err);
        }
      },
    );
}

function colorDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return pc.green(line);
      if (line.startsWith("-") && !line.startsWith("---")) return pc.red(line);
      if (line.startsWith("@@")) return pc.cyan(line);
      return line;
    })
    .join("\n");
}
