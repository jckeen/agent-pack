import type { Command } from "commander";
import pc from "picocolors";
import {
  readHistory,
  resolveAgentpackPaths,
} from "@agentpack/core";
import { failCleanly } from "../lib/error.js";

export function registerHistory(program: Command): void {
  program
    .command("history")
    .description("Show the install/uninstall/rollback history for this project.")
    .option("--project <dir>", "target project directory", process.cwd())
    .option("--pack <packId>", "filter by pack id")
    .option("--limit <n>", "show only the last N entries", "20")
    .option("--json", "emit raw JSONL on stdout", false)
    .action(
      async (options: {
        project: string;
        pack?: string;
        limit: string;
        json: boolean;
      }) => {
        try {
          const ws = await resolveAgentpackPaths(options.project);
          const all = await readHistory(ws);
          const filtered = options.pack
            ? all.filter((e) => e.packId === options.pack)
            : all;
          const limit = Math.max(1, Number.parseInt(options.limit, 10) || 20);
          const view = filtered.slice(-limit).reverse(); // newest first

          if (options.json) {
            for (const e of view) console.log(JSON.stringify(e));
            return;
          }

          if (view.length === 0) {
            console.log(pc.dim("(no history)"));
            return;
          }

          for (const e of view) {
            const colorize = actionColor(e.action);
            const tag = colorize(`[${e.action}]`);
            const where = e.target === e.profile ? e.target : `${e.target}/${e.profile}`;
            const result = e.result === "success"
              ? pc.green(e.result)
              : e.result === "partial"
                ? pc.yellow(e.result)
                : pc.red(e.result);
            console.log(
              `${pc.dim(e.timestamp)} ${tag} ${pc.bold(e.packId)}@${e.packVersion} ${pc.dim(where)} ${result} ${pc.dim(e.id)}`,
            );
            if (e.error) console.log(`  ${pc.red("error:")} ${e.error}`);
          }
        } catch (err) {
          failCleanly(err);
        }
      },
    );
}

function actionColor(action: string): (s: string) => string {
  switch (action) {
    case "install_begin":
      return pc.dim;
    case "install_commit":
      return pc.green;
    case "uninstall":
      return pc.yellow;
    case "rollback":
      return pc.cyan;
    case "install_rollback_recovery":
      return pc.red;
    default:
      return (s: string) => s;
  }
}
