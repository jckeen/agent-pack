import type { Command } from "commander";
import pc from "picocolors";
import {
  createInstallPlan,
  getAdapter,
  loadManifest,
  validateManifest,
  type TargetPlatform,
} from "@agentpack/core";
import { renderInstallPlan } from "../lib/render.js";
import { failCleanly } from "../lib/error.js";

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
        try {
          const source = target ?? process.cwd();
          const loaded = await loadManifest(source);
          const validation = validateManifest(loaded.manifest);
          if (!validation.valid) {
            console.error(
              pc.red(`✗ Manifest is invalid — run \`agentpack validate\` first.`),
            );
            for (const err of validation.errors) {
              console.error(`  • [${err.code}] ${err.path}: ${err.message}`);
            }
            process.exit(1);
          }
          const requested = options.profile;
          if (requested && !loaded.manifest.profiles[requested]) {
            console.error(
              pc.red(
                `✗ Unknown profile \`${requested}\`. Declared: ${Object.keys(loaded.manifest.profiles).join(", ")}`,
              ),
            );
            process.exit(2);
          }
          const profile =
            requested ??
            loaded.manifest.exports?.default_profile ??
            (loaded.manifest.profiles.safe ? "safe" : undefined);
          if (!profile) {
            console.error(
              pc.red(
                `✗ No profile specified and pack has no \`exports.default_profile\` or \`safe\` profile. Declared: ${Object.keys(loaded.manifest.profiles).join(", ")}`,
              ),
            );
            process.exit(2);
          }
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
        } catch (err) {
          failCleanly(err);
        }
      },
    );
}
