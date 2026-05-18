import type { Command } from "commander";
import pc from "picocolors";
import {
  createInstallPlan,
  getAdapter,
  loadManifest,
  validateManifest,
  type TargetPlatform,
} from "@workgraph/core";
import { renderInstallPlan } from "../lib/render.js";

const VALID_TARGETS: TargetPlatform[] = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
];

export function registerPlan(program: Command): void {
  program
    .command("plan [path]")
    .description("Resolve the profile, compute permissions/risk, and print the file plan an export would write.")
    .option("--target <target>", "platform target", "claude-code")
    .option("--profile <profile>", "install profile")
    .option("--only <atomIds>", "comma-separated subset of atom ids to include")
    .action(
      async (
        target: string | undefined,
        options: { target: TargetPlatform; profile?: string; only?: string },
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
        const loaded = await loadManifest(source);
        const validation = validateManifest(loaded.manifest);
        if (!validation.valid) {
          console.error(
            pc.red(`✗ Manifest is invalid — run \`workgraph validate\` first.`),
          );
          for (const err of validation.errors) {
            console.error(
              `  • [${err.code}] ${err.path}: ${err.message}`,
            );
          }
          process.exit(1);
        }
        const profile =
          options.profile ?? loaded.manifest.exports?.default_profile ?? "safe";
        const adapter = getAdapter(options.target);
        const onlyAtoms = options.only?.split(",").map((s) => s.trim()).filter(Boolean);
        const plan = await createInstallPlan({
          manifest: loaded.manifest,
          packRoot: loaded.packRoot,
          target: options.target,
          profile,
          adapter,
          onlyAtoms,
        });
        console.log(renderInstallPlan(plan));
      },
    );
}
