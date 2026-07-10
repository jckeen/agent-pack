// `agentpack update` — sync phase S1 (#110) ships the read-only `--check`
// half: re-resolve each installed pack's recorded source and report whether
// it has moved past the installed pin. The apply path (three-way reconcile,
// removals, gates) is phase S2 (#111); until it lands, a bare `update`
// defers loudly instead of pretending.
//
// Exit codes: 0 = everything current (or nothing checkable), 10 = at least
// one update available, 1 = a check failed (network, corrupt provenance).

import type { Command } from "commander";
import pc from "picocolors";
import {
  ExitCode,
  HttpRegistryClient,
  listInstallManifests,
  parseGitId,
  readInstallManifest,
  resolveAgentpackPaths,
  resolveGitSourceSha,
  type InstallManifestV1,
  type LockfileSource,
} from "@agentpack/core";
import { failCleanly } from "../lib/error.js";
import { getStoredToken } from "../lib/credentials.js";
import { latestPublishedVersion } from "../lib/registry.js";

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
      "Check installed AgentPacks against their recorded source (sync S1). " +
        "The apply path arrives in phase S2 — today only --check is supported.",
    )
    .option("--project <dir>", "target project directory", process.cwd())
    .option(
      "--check",
      "read-only: report whether the source has moved; exit 0 = current, 10 = update available",
      false,
    )
    .option("--quiet", "print nothing; communicate via the exit code only", false)
    .option("--json", "emit results as a single JSON object on stdout", false)
    .action(
      async (
        packId: string | undefined,
        options: { project: string; check: boolean; quiet: boolean; json: boolean },
      ) => {
        try {
          if (!options.check) {
            console.error(
              pc.red(
                "✗ `agentpack update` (the apply path) arrives in sync phase S2.\n" +
                  "  Today: `agentpack update --check` reports whether updates are available\n" +
                  "  (exit 10 = update available); to move now, re-run `agentpack install`\n" +
                  "  from the source.",
              ),
            );
            process.exit(ExitCode.UsageError);
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
                  `\n${updates.length} update(s) available. The apply path (\`agentpack update\`) ` +
                    `arrives in sync phase S2 — to move now, re-run \`agentpack install\` from the source.`,
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
      return fail(`recorded registry ${src.registry} is not https — refusing to contact it`);
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
          `• ${o.packId} pinned (channel: ${o.channel}, ${o.installedSha ? short(o.installedSha) : o.installedVersion}) — pinned installs never move implicitly; \`--to\` arrives in phase S2`,
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
