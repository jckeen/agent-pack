// `agentpack update` — sync S1 (#110) shipped the read-only `--check` half;
// sync S2 (#111) ships the apply path: re-fetch the recorded source, run the
// BASE/LOCAL/NEW three-way reconcile, execute surgical removals, and apply
// with install-grade gates (policy, exec re-consent, risk escalation) under
// update_begin/update_commit WAL discipline.
//
// Exit codes: 0 = applied / everything current, 10 = update available
// (--check), 6 = policy or exec-consent refusal, 2 = unresolved conflicts or
// usage error, 1 = a check/apply failed.
//
// Security posture (see #111): every gate keys off FRESHLY derived facts —
// the channel is re-derived by the fetch, never read from the stored source
// block, so a tampered manifest cannot turn a pinned install into a
// silently-tracking one.

import type { Command } from "commander";
import pc from "picocolors";
import {
  ExitCode,
  HttpRegistryClient,
  applyUpdate,
  computeExecDelta,
  enforceUpdatePolicy,
  fetchGitPack,
  listInstallManifests,
  loadPolicy,
  parseGitId,
  planInstall,
  planUpdate,
  readInstallManifest,
  recoverIncomplete,
  resolveAgentpackPaths,
  resolveGitSourceSha,
  UpdateConflictError,
  type GitSource,
  type InstallManifestV1,
  type LockfileSource,
  type UpdatePlan,
} from "@agentpack/core";
import { failCleanly } from "../lib/error.js";
import { getStoredToken } from "../lib/credentials.js";
import { latestPublishedVersion } from "../lib/registry.js";
import { globToPredicate } from "../lib/glob.js";
import { confirm } from "../lib/prompt.js";
import { CLI_VERSION } from "../lib/version.js";

interface CheckOutcome {
  packId: string;
  status: "up-to-date" | "update-available" | "pinned" | "no-provenance" | "error";
  kind?: LockfileSource["kind"];
  channel?: string;
  installedSha?: string;
  latestSha?: string;
  installedVersion?: string;
  latestVersion?: string;
  detail?: string;
}

export function registerUpdate(program: Command): void {
  program
    .command("update [packId]")
    .description(
      "Update installed AgentPacks from their recorded source: three-way reconcile " +
        "(BASE/LOCAL/NEW), surgical removals, install-grade gates. --check is the " +
        "read-only report (exit 10 = update available).",
    )
    .option("--project <dir>", "target project directory", process.cwd())
    .option(
      "--check",
      "read-only: report whether the source has moved; exit 0 = current, 10 = update available",
      false,
    )
    .option("--to <ref>", "explicit target ref — also how a pinned/tag install moves")
    .option("-y, --yes", "skip confirmation prompt", false)
    .option(
      "--allow-exec",
      "re-consent for an exec-bearing delta (added/changed hooks, MCP servers, bang-bash commands) — refused even with --yes otherwise, exactly like install",
      false,
    )
    .option(
      "--theirs <glob>",
      "on conflict: take the pack's new content for matching paths (the local edit is backed up first); repeatable",
      collect,
      [] as string[],
    )
    .option(
      "--keep-local <glob>",
      "on conflict: keep the local edit for matching paths and skip updating them; repeatable",
      collect,
      [] as string[],
    )
    .option("--dry-run", "full reconcile report, zero writes", false)
    .option("--quiet", "print nothing; communicate via the exit code only", false)
    .option("--json", "with --check: emit results as a single JSON object on stdout", false)
    .action(
      async (
        packId: string | undefined,
        options: {
          project: string;
          check: boolean;
          to?: string;
          yes: boolean;
          allowExec: boolean;
          theirs: string[];
          keepLocal: string[];
          dryRun: boolean;
          quiet: boolean;
          json: boolean;
        },
      ) => {
        try {
          if (!options.check) {
            await runApply(packId, options);
            return;
          }

          const paths = await resolveAgentpackPaths(options.project);
          const manifests: InstallManifestV1[] = packId
            ? [await readInstallManifest(paths, packId)]
            : await listInstallManifests(paths);

          if (manifests.length === 0) {
            if (options.json) {
              console.log(JSON.stringify({ updatesAvailable: false, packs: [] }));
            } else if (!options.quiet) {
              console.log(
                pc.dim("No AgentPacks installed in this project — nothing to check."),
              );
            }
            process.exit(0);
          }

          const outcomes: CheckOutcome[] = [];
          for (const manifest of manifests) {
            outcomes.push(await checkOne(manifest));
          }

          const updates = outcomes.filter((o) => o.status === "update-available");
          const errors = outcomes.filter((o) => o.status === "error");

          if (options.json) {
            console.log(
              JSON.stringify({ updatesAvailable: updates.length > 0, packs: outcomes }),
            );
          } else if (!options.quiet) {
            for (const o of outcomes) printOutcome(o);
            if (updates.length > 0) {
              console.log(
                pc.dim(
                  `\n${updates.length} update(s) available. Apply with \`agentpack update\` ` +
                    `(add a packId to update one pack; --dry-run to preview).`,
                ),
              );
            }
          }

          // update-available (10) wins over a partial check failure (1): the
          // actionable signal is "something moved", and errors are still
          // visible in the report.
          if (updates.length > 0) process.exit(ExitCode.UpdateAvailable);
          if (errors.length > 0) process.exit(ExitCode.Generic);
          process.exit(0);
        } catch (err) {
          failCleanly(err);
        }
      },
    );
}

async function checkOne(manifest: InstallManifestV1): Promise<CheckOutcome> {
  const src = manifest.source;
  if (!src) {
    return {
      packId: manifest.packId,
      status: "no-provenance",
    };
  }
  const fail = (detail: string): CheckOutcome => ({
    packId: manifest.packId,
    status: "error",
    kind: src.kind,
    detail,
  });
  try {
    if (src.kind === "github") {
      if (src.channel !== "branch") {
        return {
          packId: manifest.packId,
          status: "pinned",
          kind: src.kind,
          channel: src.channel,
          installedSha: src.resolvedSha,
        };
      }
      const parsed = parseGitId(src.id);
      if (!parsed) {
        return fail(`recorded source id is not a valid git source: ${src.id}`);
      }
      const latestSha = await resolveGitSourceSha({
        ...parsed,
        ref: src.requestedRef,
      });
      return {
        packId: manifest.packId,
        status: latestSha === src.resolvedSha ? "up-to-date" : "update-available",
        kind: src.kind,
        channel: src.channel,
        installedSha: src.resolvedSha,
        latestSha,
      };
    }
    // kind === "registry"
    if (src.channel !== "latest") {
      return {
        packId: manifest.packId,
        status: "pinned",
        kind: src.kind,
        channel: src.channel,
        installedVersion: src.resolvedVersion,
      };
    }
    // `src.registry` is read from the install manifest — attacker-influenced
    // input when a repo ships committed `.agentpack/installed/` state. Two
    // guards before any request:
    //   1. Plaintext egress only to loopback (local dev registries); anything
    //      else must be https.
    //   2. Only a token the user explicitly stored for EXACTLY this URL is
    //      attached (never the ambient AGENTPACK_TOKEN), so a tampered
    //      manifest cannot exfiltrate credentials to a host it names.
    let registryUrl: URL;
    try {
      registryUrl = new URL(src.registry);
    } catch {
      return fail(`recorded registry is not a valid URL: ${src.registry}`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(registryUrl.hostname);
    if (registryUrl.protocol !== "https:" && !loopback) {
      return fail(
        `recorded registry ${src.registry} is not https — refusing to contact it`,
      );
    }
    const token = (await getStoredToken(src.registry)) ?? undefined;
    const client = new HttpRegistryClient({ baseUrl: src.registry, token });
    const [publisher, pack] = src.id.split("/", 2);
    if (!publisher || !pack) {
      return fail(`recorded source id is not publisher/pack: ${src.id}`);
    }
    const latest = await latestPublishedVersion(client, publisher, pack);
    if (!latest) {
      return fail(`registry lists no published stable version for ${src.id}`);
    }
    return {
      packId: manifest.packId,
      status: latest === src.resolvedVersion ? "up-to-date" : "update-available",
      kind: src.kind,
      channel: src.channel,
      installedVersion: src.resolvedVersion,
      latestVersion: latest,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 12) : "(unknown)";
}

function printOutcome(o: CheckOutcome): void {
  switch (o.status) {
    case "up-to-date":
      console.log(
        pc.green(`✓ ${o.packId} up to date`) +
          pc.dim(
            ` (${o.channel}, ${o.installedSha ? short(o.installedSha) : o.installedVersion})`,
          ),
      );
      break;
    case "update-available":
      if (o.kind === "github") {
        console.log(
          pc.yellow(
            `↑ ${o.packId} update available: ${short(o.installedSha)} → ${short(o.latestSha)}`,
          ),
        );
      } else {
        console.log(
          pc.yellow(
            `↑ ${o.packId} update available: ${o.installedVersion} → ${o.latestVersion}`,
          ),
        );
      }
      break;
    case "pinned":
      console.log(
        pc.dim(
          `• ${o.packId} pinned (channel: ${o.channel}, ${o.installedSha ? short(o.installedSha) : o.installedVersion}) — pinned installs never move implicitly; move with \`agentpack update ${o.packId} --to <ref>\``,
        ),
      );
      break;
    case "no-provenance":
      console.log(
        pc.dim(
          `• ${o.packId} has no source provenance (local-path install or pre-sync lockfile) — skipped`,
        ),
      );
      break;
    case "error":
      console.error(pc.red(`! ${o.packId} check failed: ${o.detail}`));
      break;
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const SHA40_RE = /^[a-f0-9]{40}$/i;

type ApplyExit = 0 | 1 | 2 | 6;

interface ApplyCliOptions {
  project: string;
  to?: string;
  yes: boolean;
  allowExec: boolean;
  theirs: string[];
  keepLocal: string[];
  dryRun: boolean;
  quiet: boolean;
}

async function runApply(
  packId: string | undefined,
  options: ApplyCliOptions,
): Promise<never> {
  const say = options.quiet ? () => {} : console.log;
  const paths = await resolveAgentpackPaths(options.project);
  // Same posture as install: consume any crashed install/update first.
  if (!options.dryRun) {
    try {
      await recoverIncomplete(options.project);
    } catch {
      // Non-fatal — nothing to recover in a project with no .agentpack yet.
    }
  }
  const manifests: InstallManifestV1[] = packId
    ? [await readInstallManifest(paths, packId)]
    : await listInstallManifests(paths);

  if (manifests.length === 0) {
    say(pc.dim("No AgentPacks installed in this project — nothing to update."));
    process.exit(0);
  }
  if (options.to !== undefined && manifests.length > 1) {
    console.error(pc.red("✗ --to targets one pack — pass a packId alongside it."));
    process.exit(ExitCode.UsageError);
  }

  // Worst-exit aggregation across packs: policy refusal (6) > conflicts (2) >
  // error (1). The severity order happens to match numeric order, so max()
  // suffices — revisit the ordering if a future exit code breaks that.
  let worst: ApplyExit = 0;
  const bump = (code: ApplyExit) => {
    if (code > worst) worst = code;
  };

  for (const manifest of manifests) {
    bump(await applyOne(manifest, options));
  }
  process.exit(worst);
}

async function applyOne(
  manifest: InstallManifestV1,
  options: ApplyCliOptions,
): Promise<ApplyExit> {
  const say = options.quiet ? () => {} : console.log;
  const src = manifest.source;
  if (!src) {
    say(
      pc.dim(
        `• ${manifest.packId} has no source provenance (local-path install or pre-sync lockfile) — skipped`,
      ),
    );
    return 0;
  }
  if (src.kind === "registry") {
    say(
      pc.dim(
        `• ${manifest.packId} is registry-sourced — the registry apply path lands after live-smoke; ` +
          `to move now: \`agentpack install ${src.id}${options.to ? "@" + options.to : ""} --require-sig\``,
      ),
    );
    return 0;
  }

  try {
    const parsed = parseGitId(src.id);
    if (!parsed) {
      console.error(
        pc.red(
          `! ${manifest.packId}: recorded source id is not a valid git source: ${src.id}`,
        ),
      );
      return 1;
    }
    const ref = options.to ?? src.requestedRef;
    // Fast pinned check: a 40-hex requested ref can never move without --to.
    // The authoritative channel below is re-derived by the fetch — never
    // trusted from the stored block (#111 security note).
    if (options.to === undefined && ref !== null && SHA40_RE.test(ref)) {
      say(
        pc.dim(
          `• ${manifest.packId} pinned at ${ref.slice(0, 12)} — pinned installs never move implicitly; pass --to <ref> to move`,
        ),
      );
      return 0;
    }
    const source: GitSource = { ...parsed, ref };
    const fetched = await fetchGitPack({ source, fetchImpl: globalThis.fetch });
    if (options.to === undefined && fetched.channel !== "branch") {
      say(
        pc.dim(
          `• ${manifest.packId} pinned (channel: ${fetched.channel}) — pinned installs never move implicitly; pass --to <ref> to move`,
        ),
      );
      return 0;
    }
    if (fetched.resolvedSha === src.resolvedSha) {
      say(
        pc.green(`✓ ${manifest.packId} up to date`) +
          pc.dim(` (${fetched.channel}, ${fetched.resolvedSha.slice(0, 12)})`),
      );
      return 0;
    }

    const newPlan = await planInstall({
      source: fetched.tmpRoot,
      target: manifest.target,
      profile: manifest.profile,
      projectRoot: options.project,
      generator: { cli: CLI_VERSION, adapter: CLI_VERSION },
    });
    newPlan.lockfile.source = {
      kind: "github",
      id: src.id,
      requestedRef: ref,
      resolvedSha: fetched.resolvedSha,
      channel: fetched.channel,
    };
    const update = await planUpdate({ newPlan, priorManifest: manifest });

    const theirs = globToPredicate(options.theirs);
    const keepLocal = globToPredicate(options.keepLocal);

    // Freshly derived facts feed the gates: written set (clean + theirs
    // resolutions), removals, exec delta, live channel, new risk.
    const writtenPaths = [
      ...update.cleanUpdates,
      ...update.conflicts.filter((c) => theirs(c.path)).map((c) => c.path),
    ];
    const contentByPath = new Map<string, string>();
    for (const f of [...update.writeFiles, ...update.conflicts.map((c) => c.file)]) {
      contentByPath.set(f.path, f.content);
    }
    const delta = computeExecDelta({
      priorManifest: manifest,
      atomTypes: newPlan.atomTypes,
      writtenPaths,
      removedPaths: update.removals.map((r) => r.path),
      writtenContents: contentByPath,
    });
    const execDelta = delta.addedExecAtoms.length > 0 || delta.execSurfaceWrites.length > 0;
    const anyDelta = writtenPaths.length > 0 || update.removals.length > 0;

    const policy = await loadPolicy(options.project);
    const gate = enforceUpdatePolicy(policy, {
      channel: fetched.channel,
      execDelta,
      anyDelta,
      allowExec: options.allowExec,
      signatureVerified: false, // git sources cannot be signature-verified in v0.5
      installedRisk: manifest.riskLevel,
      newRisk: newPlan.riskLevel,
    });
    for (const w of gate.warnings) say(pc.yellow(`  ⚠ ${w}`));
    if (!gate.ok) {
      console.error(
        pc.red(`\n✗ ${manifest.packId} update refused by policy/consent gates:`),
      );
      for (const v of gate.violations) {
        console.error(pc.red(`  ! [${v.code}] ${v.message}`));
        if (v.hint) console.error(pc.dim(`    ${v.hint}`));
      }
      if (execDelta) {
        for (const a of delta.addedExecAtoms) {
          console.error(pc.red(`  • added exec atom: ${a}`));
        }
        for (const f of delta.execSurfaceWrites) {
          console.error(pc.red(`  • exec surface touched: ${f}`));
        }
      }
      return 6;
    }

    const unresolved = update.conflicts.filter(
      (c) => !theirs(c.path) && !keepLocal(c.path),
    );

    printUpdateReport(say, manifest.packId, src.resolvedSha, fetched.resolvedSha, update, {
      theirs,
      keepLocal,
    });

    if (options.dryRun) {
      say(pc.dim("\n(--dry-run) No files were written."));
      return unresolved.length > 0 ? 2 : 0;
    }
    if (unresolved.length > 0) {
      console.error(
        pc.red(
          `\n✗ ${unresolved.length} conflict(s) — the local file and the new pack version both changed:`,
        ),
      );
      for (const c of unresolved) console.error(pc.red(`  • ${c.path} (${c.reason})`));
      console.error(
        pc.dim(
          "  Resolve with --theirs <glob> (take the pack's version; local edit backed up) or --keep-local <glob> (keep the local edit).",
        ),
      );
      return 2;
    }

    if (!options.yes) {
      const ok = await confirm(
        pc.bold(
          `\nUpdate ${manifest.packId} ${update.fromVersion} → ${update.toVersion} (${src.resolvedSha.slice(0, 12)} → ${fetched.resolvedSha.slice(0, 12)})? [y/N] `,
        ),
      );
      if (!ok) {
        say(pc.dim("Aborted."));
        return 1;
      }
    }

    const result = await applyUpdate({
      update,
      resolutions: { theirs, keepLocal },
      actor: { type: "cli" },
    });
    say(
      pc.green(
        `\n✓ Updated ${manifest.packId} ${update.fromVersion} → ${update.toVersion} (${fetched.resolvedSha.slice(0, 12)}).`,
      ),
    );
    say(pc.dim(`  • ${result.written.length} file(s) written.`));
    if (result.removed.length > 0) {
      say(
        pc.dim(
          `  • ${result.removed.length} file(s) removed: ${result.removed.join(", ")}`,
        ),
      );
    }
    if (result.skippedRemovals.length > 0) {
      say(
        pc.yellow(
          `  ⚠ removal skipped (user-edited): ${result.skippedRemovals.join(", ")}`,
        ),
      );
    }
    if (result.retained.length > 0) {
      say(pc.dim(`  • retained local edits: ${result.retained.join(", ")}`));
    }
    say(pc.dim(`  • History entry: ${result.commitEntry.id}`));
    return 0;
  } catch (err) {
    if (err instanceof UpdateConflictError) {
      console.error(pc.red(`✗ ${manifest.packId}: ${err.message}`));
      return 2;
    }
    console.error(
      pc.red(
        `! ${manifest.packId} update failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return 1;
  }
}

function printUpdateReport(
  say: (msg: string) => void,
  packId: string,
  fromSha: string,
  toSha: string,
  update: UpdatePlan,
  resolutions: { theirs: (p: string) => boolean; keepLocal: (p: string) => boolean },
): void {
  say(
    pc.bold(
      `\nUpdate plan: ${packId} ${update.fromVersion} → ${update.toVersion} (${fromSha.slice(0, 12)} → ${toSha.slice(0, 12)})`,
    ),
  );
  if (update.cleanUpdates.length > 0) {
    say(pc.cyan(`Apply (${update.cleanUpdates.length}):`));
    for (const p of update.cleanUpdates) say(pc.cyan(`  ~ ${p}`));
  }
  if (update.retainedDrift.length > 0) {
    say(
      pc.dim(`Retained local edits (upstream unchanged, ${update.retainedDrift.length}):`),
    );
    for (const p of update.retainedDrift) say(pc.dim(`  = ${p}`));
  }
  if (update.removals.length > 0) {
    say(pc.yellow(`Remove (upstream deleted, ${update.removals.length}):`));
    for (const r of update.removals) say(pc.yellow(`  - ${r.path}`));
  }
  for (const c of update.conflicts) {
    const resolution = resolutions.theirs(c.path)
      ? "resolved: --theirs"
      : resolutions.keepLocal(c.path)
        ? "resolved: --keep-local"
        : "UNRESOLVED";
    say(pc.red(`  ! ${c.path} (${c.reason}) — ${resolution}`));
  }
}
