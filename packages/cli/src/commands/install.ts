import type { Command } from "commander";
import pc from "picocolors";
import {
  planInstall,
  applyInstall,
  recoverIncomplete,
  type TargetPlatform,
} from "@workgraph/core";
import { failCleanly } from "../lib/error.js";
import { riskBadge } from "../lib/render.js";
import { CLI_VERSION } from "../lib/version.js";
import { confirm } from "../lib/prompt.js";

const VALID_TARGETS: TargetPlatform[] = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
];

export function registerInstall(program: Command): void {
  program
    .command("install [pack]")
    .description("Install an AgentPack into a project directory.")
    .option("--target <target>", "platform target", "claude-code")
    .option("--profile <profile>", "install profile (e.g. safe, standard, full)")
    .option("--project <dir>", "target project directory", process.cwd())
    .option("-y, --yes", "skip confirmation prompt", false)
    .option("--dry-run", "print diff and exit without writing", false)
    .option("--force", "overwrite existing files without an AgentPack marker", false)
    .action(
      async (
        pack: string | undefined,
        options: {
          target: TargetPlatform;
          profile?: string;
          project: string;
          yes: boolean;
          dryRun: boolean;
          force: boolean;
        },
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
          // Run recovery sweep on every install — if a previous install
          // crashed, this is when we clean up. Idempotent on clean state.
          try {
            await recoverIncomplete(options.project);
          } catch {
            // Non-fatal: directory may not exist yet (first install). Plan
            // will validate projectRoot below.
          }
          const plan = await planInstall({
            source,
            target: options.target,
            profile: options.profile ?? "safe",
            projectRoot: options.project,
            generator: { cli: CLI_VERSION, adapter: CLI_VERSION },
          });

          printPlanSummary(plan);

          if (options.dryRun) {
            console.log(pc.dim("\n(--dry-run) No files were written."));
            return;
          }

          if (plan.conflicts.length > 0 && !options.force) {
            console.error(
              pc.red(
                `\n✗ ${plan.conflicts.length} conflict(s) detected. Re-run with --force to back up and overwrite, or resolve manually.`,
              ),
            );
            process.exit(2);
          }

          if (!options.yes) {
            const ok = await confirm(
              pc.bold(
                `\nInstall ${plan.packId}@${plan.packVersion} → ${options.project}? [y/N] `,
              ),
            );
            if (!ok) {
              console.log(pc.dim("Aborted."));
              process.exit(0);
            }
          }

          const result = await applyInstall({ plan, force: options.force });
          console.log(
            pc.green(
              `\n✓ Installed ${plan.packId}@${plan.packVersion} (${plan.target}, ${plan.profile}).`,
            ),
          );
          console.log(
            pc.dim(`  • ${result.written.length} files written.`),
          );
          console.log(
            pc.dim(
              `  • Manifest: ${result.manifestPath.replace(plan.projectRoot, ".")}`,
            ),
          );
          console.log(pc.dim(`  • History entry: ${result.commitEntry.id}`));
          console.log(
            pc.dim(
              `\nConsider adding to .gitignore:\n  .workgraph/installed/\n  .workgraph/backups/\n  .workgraph/history.jsonl\n  .workgraph/.lock\nKeep \`AGENTPACK.lock\` committed for reproducibility.`,
            ),
          );
        } catch (err) {
          failCleanly(err);
        }
      },
    );
}

function printPlanSummary(plan: ReturnType<typeof planInstall> extends Promise<infer T> ? T : never): void {
  console.log(
    pc.bold(
      `\nInstall plan: ${plan.packId}@${plan.packVersion} → ${plan.target} (${plan.profile})`,
    ),
  );
  console.log(`Risk: ${riskBadge(plan.riskLevel)}`);
  if (plan.warnings.length > 0) {
    console.log(pc.yellow(`\nWarnings:`));
    for (const w of plan.warnings) console.log(pc.yellow(`  ⚠ ${w}`));
  }
  if (plan.created.length > 0) {
    console.log(pc.green(`\nCreate (${plan.created.length}):`));
    for (const f of plan.created) console.log(pc.green(`  + ${f.path}`));
  }
  if (plan.modified.length > 0) {
    console.log(pc.cyan(`\nModify (${plan.modified.length}):`));
    for (const f of plan.modified) console.log(pc.cyan(`  ~ ${f.path}`));
  }
  if (plan.unchanged.length > 0) {
    console.log(pc.dim(`\nUnchanged (${plan.unchanged.length}):`));
    for (const f of plan.unchanged) console.log(pc.dim(`  · ${f.path}`));
  }
  if (plan.conflicts.length > 0) {
    console.log(pc.red(`\nConflicts (${plan.conflicts.length}):`));
    for (const c of plan.conflicts) {
      const detail =
        c.reason === "other-pack-marker"
          ? `belongs to pack \`${c.otherPackId}\``
          : `existing file has no AgentPack marker`;
      console.log(pc.red(`  ! ${c.file.path} — ${detail}`));
    }
  }
}

