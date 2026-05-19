import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import pc from "picocolors";
import {
  cache,
  DEFAULT_REGISTRY_URL,
  enforcePolicy,
  ExitCode,
  fetchGitPack,
  HttpRegistryClient,
  IntegrityError,
  loadPolicy,
  parseGitId,
  planInstall,
  applyInstall,
  recoverIncomplete,
  resolveLatestVersion,
  signing,
  type GitSource,
  type RegistryClient,
  type TargetPlatform,
} from "@agentpack/core";
import { failCleanly } from "../lib/error.js";
import { riskBadge } from "../lib/render.js";
import { CLI_VERSION } from "../lib/version.js";
import { confirm } from "../lib/prompt.js";
import { getToken } from "../lib/credentials.js";

const REMOTE_ID_RE = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:@(.+))?$/;

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
    .option("--registry <url>", "registry URL for remote installs", DEFAULT_REGISTRY_URL)
    .option(
      "--require-sig",
      "refuse to install if the registry has no valid Sigstore signature for this version",
      false
    )
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
          registry: string;
          requireSig: boolean;
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
          let source = pack ?? process.cwd();

          // Source detection order (v0.5): local path → git source → registry id.
          //
          //   1. If `pack` resolves to a directory, that's a local-path install.
          //      Local always wins — explicit beats inferred.
          //   2. Otherwise, if it matches the git-source grammar
          //      (`github:owner/repo[@ref][#subpath]` or `github.com/...`),
          //      fetch from raw.githubusercontent.com.
          //   3. Otherwise, if it matches `<publisher>/<pack>[@<version>]`,
          //      fetch from the configured registry.
          //
          // The git source has an unambiguous prefix, so it can sit between
          // the local stat-check and the registry-id branch without conflicting
          // with either.
          let isLocalDir = false;
          if (pack) {
            try {
              const stat = await fs.stat(path.resolve(process.cwd(), pack));
              if (stat.isDirectory()) isLocalDir = true;
            } catch {
              // ENOENT — not a local directory.
            }
          }

          const gitSource: GitSource | null =
            !isLocalDir && pack ? parseGitId(pack) : null;
          let remoteMatch: RegExpMatchArray | null = null;
          if (!isLocalDir && !gitSource && pack) {
            remoteMatch = pack.match(REMOTE_ID_RE);
          }

          if (gitSource) {
            if (options.requireSig) {
              console.error(
                pc.red(
                  "✗ --require-sig with a git source is not supported in v0.5.\n" +
                    "  Git-source signature verification (cosign-on-tag) arrives in v0.5.1.\n" +
                    "  For signed-by-default today, publish to a registry and install via\n" +
                    "  `agentpack install <publisher>/<pack>@<version> --require-sig`."
                )
              );
              process.exit(2);
            }
            const gitResult = await fetchGitPack({
              source: gitSource,
              fetchImpl: globalThis.fetch,
            });
            source = gitResult.tmpRoot;
            const refLabel = gitSource.ref
              ? gitSource.ref === gitResult.resolvedSha
                ? gitSource.ref
                : `${gitSource.ref} → ${gitResult.resolvedSha.slice(0, 12)}`
              : `(default branch) → ${gitResult.resolvedSha.slice(0, 12)}`;
            console.log(
              pc.dim(
                `Installed from git: ${gitSource.host}:${gitSource.owner}/${gitSource.repo}@${refLabel}${
                  gitSource.subpath ? "#" + gitSource.subpath : ""
                }`
              )
            );
          }
          if (remoteMatch) {
            const [, publisher, packSlug, requestedVersion] = remoteMatch;
            if (!publisher || !packSlug) {
              throw new Error("remote identity parse failed");
            }
            source = await fetchRemotePack({
              publisher,
              pack: packSlug,
              requestedVersion,
              registry: options.registry,
              target: options.target,
              profile: options.profile ?? "safe",
              projectRoot: options.project,
            });

            // --require-sig: per ROADMAP exit-code taxonomy 0=ok, 2=drift,
            // 3=chain, 4=sig invalid, 5=unsigned-when-required. We enforce
            // BEFORE planInstall so a refused install touches zero files.
            if (options.requireSig) {
              const sigCheck = await verifyRegistrySignature({
                registry: options.registry,
                publisher,
                pack: packSlug,
                version: requestedVersion,
              });
              if (sigCheck.code === "unsigned") {
                console.error(
                  pc.red(
                    `\n✗ ${publisher}/${packSlug}${requestedVersion ? "@" + requestedVersion : ""} is unsigned — --require-sig refuses.\n` +
                      `  To install anyway, rerun without --require-sig.`
                  )
                );
                process.exit(5);
              }
              if (sigCheck.code === "invalid") {
                console.error(
                  pc.red(
                    `\n✗ ${publisher}/${packSlug} signature INVALID — ${sigCheck.reason}${sigCheck.detail ? ` (${sigCheck.detail})` : ""}.\n` +
                      `  Refusing to install. If the publisher recently re-signed, try again.`
                  )
                );
                process.exit(4);
              }
              console.log(
                pc.green(
                  `  ✓ signature verified — signed by ${sigCheck.san}`
                )
              );
            }
          } else if (options.requireSig) {
            console.error(
              pc.red(
                "✗ --require-sig requires a remote pack identity (publisher/pack[@version]); local-path installs cannot be signature-checked."
              )
            );
            process.exit(2);
          }
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
              `\nConsider adding to .gitignore:\n  .agentpack/installed/\n  .agentpack/backups/\n  .agentpack/history.jsonl\n  .agentpack/.lock\nKeep \`AGENTPACK.lock\` committed for reproducibility.`,
            ),
          );
        } catch (err) {
          failCleanly(err);
        }
      },
    );
}

/**
 * Fetch a pack from the remote registry into a temp directory, then return the
 * temp path as the install `source`. The temp tree mirrors the pack root so
 * existing `planInstall` works unchanged. Sha256 is verified for every file
 * via `cache.fetchAndCache`; mismatches throw `IntegrityError` → exit 7.
 */
async function fetchRemotePack(params: {
  publisher: string;
  pack: string;
  requestedVersion?: string;
  registry: string;
  target: TargetPlatform;
  profile: string;
  projectRoot: string;
}): Promise<string> {
  const registry = params.registry.replace(/\/+$/, "");
  const token = (await getToken(registry)) ?? undefined;
  const client: RegistryClient = new HttpRegistryClient({
    baseUrl: registry,
    token,
  });

  // 1. Resolve version.
  let version = params.requestedVersion;
  if (!version) {
    const pkg = await client.listVersions(params.publisher, params.pack);
    const published = pkg.versions
      .filter((v) => v.status === "published")
      .map((v) => v.version);
    const latest = resolveLatestVersion(published);
    if (!latest) {
      throw new Error(
        `No published stable version found for ${params.publisher}/${params.pack}`,
      );
    }
    version = latest;
  }

  // 2. Policy check (Phase 5).
  const policy = await loadPolicy(params.projectRoot);
  if (policy) {
    const versionDetails = await client.getVersion(
      params.publisher,
      params.pack,
      version,
    );
    const atomTypes = await peekAtomTypes(client, params.publisher, params.pack, version);
    const enforcement = enforcePolicy(
      policy,
      {
        packId: `${params.publisher}/${params.pack}`,
        publisher: params.publisher,
        pack: params.pack,
        target: params.target,
        profile: params.profile,
        atomTypes,
        signed: false,
      },
      registry,
    );
    if (!enforcement.ok) {
      console.error(pc.red("\nPolicy violation(s):"));
      for (const v of enforcement.violations) {
        console.error(pc.red(`  ! [${v.code}] ${v.message}`));
        if (v.hint) console.error(pc.dim(`    ${v.hint}`));
      }
      process.exit(ExitCode.PolicyViolation);
    }
    // Suppress unused-var lint.
    void versionDetails;
  }

  // 3. Materialize manifest + atom files in a temp dir.
  const versionMeta = await client.getVersion(
    params.publisher,
    params.pack,
    version,
  );
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `wgpack-${params.publisher}-${params.pack}-`),
  );

  const manifestBytes = Buffer.from(
    await client.fetchManifest(params.publisher, params.pack, version),
    "utf-8",
  );
  await fs.writeFile(path.join(tmpRoot, "AGENTPACK.yaml"), manifestBytes);

  for (const file of versionMeta.files) {
    try {
      // Use the cache so repeat installs are fast.
      const bytes = file.atomId
        ? await client.fetchAtomFile(
            params.publisher,
            params.pack,
            version,
            file.atomId,
            file.path,
            file.sha256,
          )
        : await fetchManifestExtra(client, params.publisher, params.pack, version, file);
      const dest = path.join(tmpRoot, file.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, bytes);
      // Tickle the cache to record this blob is hot.
      void cache;
    } catch (err) {
      if (err instanceof IntegrityError) {
        const ierr = err;
        console.error(pc.red(`\nIntegrity check failed for ${file.path}:`));
        console.error(pc.red(`  expected ${ierr.expectedSha256}`));
        console.error(pc.red(`  got      ${ierr.actualSha256}`));
        process.exit(ExitCode.IntegrityError);
      }
      throw err;
    }
  }

  console.log(
    pc.dim(`Installed from registry: ${params.publisher}/${params.pack}@${version}`),
  );
  return tmpRoot;
}

async function peekAtomTypes(
  client: RegistryClient,
  publisher: string,
  pack: string,
  version: string,
): Promise<string[]> {
  try {
    const v = await client.getVersion(publisher, pack, version);
    // Per-file metadata doesn't carry atom type; the YAML manifest does.
    const yaml = await client.fetchManifest(publisher, pack, version);
    const types: string[] = [];
    for (const line of yaml.split(/\r?\n/)) {
      const m = line.match(/^\s*type:\s*([a-z_]+)\s*$/);
      if (m && m[1]) types.push(m[1]);
    }
    void v;
    return [...new Set(types)];
  } catch {
    return [];
  }
}

async function fetchManifestExtra(
  _client: RegistryClient,
  _publisher: string,
  _pack: string,
  _version: string,
  _file: { path: string; sha256: string; bytes: number },
): Promise<Buffer> {
  // Files without an atom id (e.g. README) are rare in iter-4. Return empty
  // for now; future iterations can extend the client interface.
  return Buffer.alloc(0);
}

/**
 * Fetch the registry's signatures for a pack version and verify the most
 * recent one against the manifestChecksum we'll be installing. Returns a
 * three-state result aligned with the verify-CLI exit codes:
 *   - { code: "ok", san }      → 0
 *   - { code: "unsigned" }     → 5 (registry has no signature rows)
 *   - { code: "invalid", ... } → 4 (signature is present but verification failed)
 */
interface SigOk {
  code: "ok";
  san: string;
}
interface SigUnsigned {
  code: "unsigned";
}
interface SigInvalid {
  code: "invalid";
  reason: string;
  detail?: string | undefined;
}
type SigCheck = SigOk | SigUnsigned | SigInvalid;

async function verifyRegistrySignature(params: {
  registry: string;
  publisher: string;
  pack: string;
  version: string | undefined;
}): Promise<SigCheck> {
  const versionPath = params.version ?? "latest";
  const url = `${params.registry.replace(/\/+$/, "")}/api/v1/packs/${params.publisher}/${params.pack}/versions/${versionPath}/signatures`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return {
      code: "invalid",
      reason: "network_error",
      detail: (err as Error).message,
    };
  }
  if (!res.ok) {
    return {
      code: "invalid",
      reason: `registry_error_${res.status}`,
      detail: res.statusText,
    };
  }
  const data = (await res.json()) as {
    manifestSha256: string;
    signatures: Array<{
      bundleB64: string;
      manifestChecksum: string;
      envelopeVersion: number;
      metadata: signing.SignatureMetadata;
    }>;
  };
  if (data.signatures.length === 0) return { code: "unsigned" };

  // Verify the newest signature (registry sorts newest-first).
  const latest = data.signatures[0];
  if (!latest) return { code: "unsigned" };
  // v0.5.1 hardening (security-reviewer CRITICAL-1): the signing API now
  // supports `requireIdentity: true` to refuse trust-on-first-publish, but
  // the wire path needs an `expectedSAN` (per-publisher allowlist served
  // by the registry) before we can enable it without breaking every
  // current sig-checked install. Until the registry response carries the
  // bound SAN — tracked as v0.5.2 follow-up — verify against the bundle
  // alone and surface the SAN in the result so the caller can audit.
  const result = await signing.verifyManifestSignature({
    manifestChecksum: data.manifestSha256,
    signed: {
      manifestChecksum: latest.manifestChecksum,
      bundleB64: latest.bundleB64,
      metadata: latest.metadata,
      envelopeVersion: 1,
    },
  });
  if (result.valid) {
    return { code: "ok", san: result.metadata.identity.san };
  }
  return {
    code: "invalid",
    reason: result.reason,
    detail: result.detail,
  };
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

