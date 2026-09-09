import { promises as fs } from "node:fs";

import type { Command } from "commander";
import pc from "picocolors";
import {
  allUserScopeRoots,
  InstallManifestNotFoundError,
  planUninstall,
  uninstall,
  UninstallConflictError,
  UninstallUnparsableConfigError,
  readInstallManifest,
  resolveAgentpackPaths,
  type InstallManifestV1,
} from "@agentpack/core";
import { failCleanly } from "../lib/error.js";
import { confirm } from "../lib/prompt.js";

export function registerUninstall(program: Command): void {
  program
    .command("uninstall <packId>")
    .description("Remove a previously-installed AgentPack from the project.")
    .option("--project <dir>", "target project directory", process.cwd())
    .option(
      "--scope <scope>",
      "uninstall scope: `project` (default) or `user` — user scope targets the pack's user-root install(s) (~/.claude, ~/.codex, ~/.gemini/config)",
      "project",
    )
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
          scope: string;
          yes: boolean;
          force: boolean;
          forceRestore: boolean;
        },
        command: Command,
      ) => {
        try {
          if (options.scope !== "project" && options.scope !== "user") {
            console.error(
              pc.red(`Invalid --scope \`${options.scope}\`. Choose: project, user`),
            );
            process.exit(2);
          }
          // `--scope user` targets the pack's user-root install(s) — the exit
          // door for `install --scope user` (#146; multi-runtime roots in
          // #132). The pack may be installed under one or several user roots
          // (~/.claude for claude-code, ~/.codex for codex, ~/.gemini/config
          // for generic); uninstall removes it from every root that has it.
          let targets: Array<{ project: string; manifest: InstallManifestV1 }>;
          if (options.scope === "user") {
            if (command.getOptionValueSource("project") === "cli") {
              console.error(
                pc.red(
                  "✗ --project and --scope user are mutually exclusive — user scope always targets the user config roots.",
                ),
              );
              process.exit(2);
            }
            targets = [];
            const roots = allUserScopeRoots();
            for (const root of roots) {
              const isDir = await fs
                .stat(root)
                .then((s) => s.isDirectory())
                .catch(() => false);
              if (!isDir) continue;
              const ws = await resolveAgentpackPaths(root);
              try {
                targets.push({
                  project: root,
                  manifest: await readInstallManifest(ws, packId),
                });
              } catch (err) {
                if (!(err instanceof InstallManifestNotFoundError)) throw err;
              }
            }
            if (targets.length === 0) {
              throw new InstallManifestNotFoundError(packId, roots.join(", "));
            }
          } else {
            const ws = await resolveAgentpackPaths(options.project);
            targets = [
              { project: options.project, manifest: await readInstallManifest(ws, packId) },
            ];
          }

          // PHASE 1 — scan EVERY selected root before any mutation (#194).
          // A conflict or unparsable config in a later root must refuse the
          // whole uninstall while every root is still untouched; planning
          // one root and applying it before scanning the next left earlier
          // roots half-uninstalled with no way back. Every root's refusal is
          // reported, not just the first.
          const refusals: string[] = [];
          for (const { project, manifest } of targets) {
            const where =
              targets.length > 1 || options.scope === "user" ? ` — ${project}` : "";
            console.log(
              pc.bold(
                `\nUninstall plan: ${manifest.packId}@${manifest.packVersion} (${manifest.target}, ${manifest.profile})${where}`,
              ),
            );
            // Merged files (shared CLAUDE.md/AGENTS.md, JSON configs) are
            // surgically un-merged — only the pack's span/entries come out, the
            // user's surrounding content stays. They are NOT backup restores, so
            // show them separately or the "Restore (n)" count contradicts the
            // "0 restored" result (QA P2-2).
            const mergePaths = new Set((manifest.merges ?? []).map((m) => m.path));
            const restores = manifest.backups.filter((b) => !mergePaths.has(b.original));
            // A merged file lists ONLY under Unmerge — it also appears in
            // `created` when the pack introduced it, but its uninstall action is
            // the merge one (span/entry removal; whole-file only when nothing
            // else remains), and double-listing reads as removing it twice
            // (#149c).
            const removals = manifest.created.filter((c) => !mergePaths.has(c.path));
            console.log(pc.green(`  Remove (${removals.length}):`));
            for (const c of removals) console.log(pc.green(`    − ${c.path}`));
            if (manifest.merges && manifest.merges.length > 0) {
              console.log(pc.cyan(`  Unmerge (${manifest.merges.length}):`));
              for (const m of manifest.merges)
                console.log(pc.cyan(`    ✂ ${m.path} (${m.strategy})`));
            }
            console.log(pc.cyan(`  Restore (${restores.length}):`));
            for (const b of restores) console.log(pc.cyan(`    ↺ ${b.original}`));

            try {
              await planUninstall({
                packId,
                projectRoot: project,
                force: options.force,
                forceRestore: options.forceRestore,
              });
            } catch (err) {
              if (
                err instanceof UninstallConflictError ||
                err instanceof UninstallUnparsableConfigError
              ) {
                refusals.push(`${where ? `${project}: ` : ""}${err.message}`);
                continue;
              }
              throw err;
            }
          }
          if (refusals.length > 0) {
            for (const r of refusals) console.error(pc.red("✗ ") + r);
            console.error(
              pc.red(`\nNothing was uninstalled (${targets.length} root(s) unchanged).`),
            );
            process.exit(2);
          }

          // Confirmation covers the complete plan — every root printed above.
          if (!options.yes) {
            const ok = await confirm(pc.bold(`\nProceed with uninstall? [y/N] `));
            if (!ok) {
              console.log(pc.dim("Aborted."));
              process.exit(1);
            }
          }

          // PHASE 2 — apply per root. `uninstall` re-scans its own root before
          // acting, so a file that changed between the pre-scan and the apply
          // is still refused for THAT root (per-root safety is unchanged; the
          // pre-scan is not a cross-root transaction).
          for (const { project } of targets) {
            const result = await uninstall({
              packId,
              projectRoot: project,
              force: options.force,
              forceRestore: options.forceRestore,
            });
            const where = targets.length > 1 ? ` (${project})` : "";
            console.log(pc.green(`\n✓ Uninstalled ${packId}${where}.`));
            console.log(
              pc.dim(
                `  • ${result.removed.length} removed, ${result.restored.length} restored, ${result.conflicts.length} conflicts.`,
              ),
            );
            // Lockfile v2 (#114): uninstall removes only this pack's entry.
            const lockNote = {
              "entry-removed": `AGENTPACK.lock updated (${packId} entry removed; other packs' entries retained).`,
              "file-removed": `AGENTPACK.lock removed (${packId} was the last installed pack; history.jsonl keeps the audit trail).`,
              "not-tracked": `AGENTPACK.lock untouched (no entry for ${packId}).`,
              "unrecognized-left-in-place": `AGENTPACK.lock could not be parsed — left in place; inspect or delete it manually.`,
            }[result.lockfile];
            console.log(pc.dim(`  • ${lockNote}`));
          }
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
