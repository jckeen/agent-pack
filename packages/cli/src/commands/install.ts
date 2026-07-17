import { createHash } from "node:crypto";
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
  LOCKFILE_NAME,
  parseGitId,
  planInstall,
  applyInstall,
  countIncompleteInstalls,
  recoverIncomplete,
  signing,
  type GitSource,
  type LockfileSource,
  type RegistryClient,
  type TargetPlatform,
} from "@agentpack/core";
import { failCleanly } from "../lib/error.js";
import { latestPublishedVersion } from "../lib/registry.js";
import { renderPermissionSummary, riskBadge } from "../lib/render.js";
import { CLI_VERSION } from "../lib/version.js";
import { confirm } from "../lib/prompt.js";
import { getToken } from "../lib/credentials.js";

const REMOTE_ID_RE =
  /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:@(.+))?$/;

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
    .option(
      "--scope <scope>",
      "install scope: `project` (default) or `user` — user scope installs into ~/.claude with user-layout paths (claude-code target only; state at ~/.claude/.agentpack/)",
      "project",
    )
    .option("-y, --yes", "skip confirmation prompt", false)
    .option("--dry-run", "print diff and exit without writing", false)
    .option("--force", "overwrite existing files without an AgentPack marker", false)
    .option("--registry <url>", "registry URL for remote installs", DEFAULT_REGISTRY_URL)
    .option(
      "--require-sig",
      "refuse to install if the registry has no valid Sigstore signature for this version",
      false,
    )
    .option("--json", "emit the plan/result as a single JSON object on stdout", false)
    .option(
      "--expected-signer <san>",
      "with --require-sig: require the Sigstore certificate identity (SAN) to equal this value",
    )
    .option(
      "--allow-critical",
      "permit installing a pack whose computed risk level is critical (otherwise refused even with --yes)",
      false,
    )
    .option(
      "--allow-exec",
      "permit installing an UNVERIFIED pack that ships executable atoms (hook / mcp_server) — refused even with --yes unless the install is signature-verified via --require-sig",
      false,
    )
    .option(
      "--allow-partial-target",
      "permit installing to a target the pack's authored compatibility declares `partial` or `experimental` (otherwise refused even with --yes)",
      false,
    )
    .option(
      "--fail-on-unsupported",
      "exit non-zero instead of installing when any selected atom is dropped (target-incompatible or refused by a security gate)",
      false,
    )
    .action(
      async (
        pack: string | undefined,
        options: {
          target: TargetPlatform;
          profile?: string;
          project: string;
          scope: string;
          yes: boolean;
          dryRun: boolean;
          force: boolean;
          registry: string;
          requireSig: boolean;
          json: boolean;
          expectedSigner?: string;
          allowCritical: boolean;
          allowExec: boolean;
          allowPartialTarget: boolean;
          failOnUnsupported: boolean;
        },
        command: Command,
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
          if (options.scope !== "project" && options.scope !== "user") {
            console.error(
              pc.red(`Invalid --scope \`${options.scope}\`. Choose: project, user`),
            );
            process.exit(2);
          }
          const scope = options.scope as "project" | "user";
          // Sync S3 (#112): `--scope user` roots the install at ~/.claude and
          // remaps adapter output to the user layout. State (.agentpack/)
          // lands at ~/.claude/.agentpack/ — never inside any project.
          if (scope === "user") {
            if (options.target !== "claude-code") {
              console.error(
                pc.red(
                  `✗ --scope user is only supported with --target claude-code (got \`${options.target}\`).`,
                ),
              );
              process.exit(2);
            }
            if (command.getOptionValueSource("project") === "cli") {
              console.error(
                pc.red(
                  "✗ --project and --scope user are mutually exclusive — user scope always installs into ~/.claude.",
                ),
              );
              process.exit(2);
            }
            const userRoot = path.join(os.homedir(), ".claude");
            const exists = await fs
              .stat(userRoot)
              .then((s) => s.isDirectory())
              .catch(() => false);
            if (!exists) {
              if (options.dryRun) {
                // A dry-run must never mutate ~ — including creating ~/.claude.
                console.error(
                  pc.red(
                    `✗ ${userRoot} does not exist. --dry-run never creates it; run without --dry-run to install (which will create it).`,
                  ),
                );
                process.exit(2);
              }
              await fs.mkdir(userRoot, { recursive: true });
            }
            options.project = userRoot;
          }
          // #145: a --project directory that doesn't exist yet is part of the
          // write plan, not an error. Plan against an empty stand-in dir (a
          // nonexistent root is behaviorally an empty one), then create the
          // real directory only AFTER consent — never under --dry-run. An
          // existing non-directory still fails via resolveAgentpackPaths.
          const projectAbs = path.resolve(options.project);
          const projectMissing = (await fs.stat(projectAbs).catch(() => null)) === null;
          let planProjectRoot = options.project;
          if (projectMissing) {
            planProjectRoot = await fs.mkdtemp(
              path.join(os.tmpdir(), "agentpack-newdir-standin-"),
            );
          }
          let source = pack ?? process.cwd();
          // #35 fix 3: when --require-sig verifies a signature, carry the
          // verified envelope here so it gets persisted into AGENTPACK.lock's
          // signatures.manifest — otherwise a later `verify --sig` would falsely
          // report the install unsigned.
          let verifiedSignatureB64: string | undefined;
          // Sync S1 (#110): provenance recorded for git + registry installs so
          // `agentpack update` can answer "where would an update come from?".
          // Stays undefined for local-path installs — their lockfiles must
          // remain byte-identical to pre-S1 output.
          let sourceProvenance: LockfileSource | undefined;

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
          let packExistsAsPath = false;
          if (pack) {
            try {
              const stat = await fs.stat(path.resolve(process.cwd(), pack));
              packExistsAsPath = true;
              if (stat.isDirectory()) isLocalDir = true;
            } catch {
              // ENOENT — not a local directory.
            }
          }

          const gitSource: GitSource | null = !isLocalDir && pack ? parseGitId(pack) : null;
          // An arg that LOOKS like a git source but failed to parse must not
          // fall through to the local-path or registry branches — the
          // resulting "Could not access path github:..." error sends the
          // caller down the wrong debugging trail.
          if (!isLocalDir && !gitSource && pack && /^github(\.com)?[:/]/.test(pack)) {
            console.error(
              pc.red(
                `✗ \`${pack}\` is not a valid git source. Expected \`github:owner/repo[@ref][#subpath]\` — ` +
                  `refs allow [A-Za-z0-9._/+-], subpaths must be relative without \`..\`.`,
              ),
            );
            process.exit(2);
          }
          let remoteMatch: RegExpMatchArray | null = null;
          if (!isLocalDir && !gitSource && pack) {
            remoteMatch = pack.match(REMOTE_ID_RE);
          }
          // #147: a bare name (`agentpack install pr-quality`) matches none of
          // the three source forms — no path separator or scheme, nothing on
          // disk, and the registry grammar needs `publisher/pack`. Falling
          // through would treat it as a local path and surface a raw ENOENT;
          // guide instead.
          if (
            pack &&
            !packExistsAsPath &&
            !gitSource &&
            !remoteMatch &&
            !/[/\\:]/.test(pack)
          ) {
            console.error(
              pc.red(
                `✗ \`${pack}\` is not an installable source — nothing exists at that path, and bare names cannot be resolved.\n` +
                  `  Expected one of:\n` +
                  `    • a local pack path  e.g. ./examples/pr-quality (a directory containing AGENTPACK.yaml)\n` +
                  `    • a git source       e.g. github:jckeen/agent-pack@master#examples/pr-quality\n` +
                  `    • a registry id      e.g. agentpack/pr-quality@0.1.0`,
              ),
            );
            process.exit(2);
          }

          if (gitSource) {
            if (options.requireSig) {
              console.error(
                pc.red(
                  "✗ --require-sig with a git source is not supported in v0.5.\n" +
                    "  Git-source signature verification (cosign-on-tag) arrives in v0.5.1.\n" +
                    "  For signed-by-default today, publish to a registry and install via\n" +
                    "  `agentpack install <publisher>/<pack>@<version> --require-sig`.",
                ),
              );
              process.exit(2);
            }
            const gitResult = await fetchGitPack({
              source: gitSource,
              fetchImpl: globalThis.fetch,
            });
            source = gitResult.tmpRoot;
            sourceProvenance = {
              kind: "github",
              // Canonical re-fetchable id WITHOUT the ref — the recorded
              // requestedRef/channel say how to move, the id says where.
              id: `github:${gitSource.owner}/${gitSource.repo}${
                gitSource.subpath ? `#${gitSource.subpath}` : ""
              }`,
              requestedRef: gitSource.ref,
              resolvedSha: gitResult.resolvedSha,
              channel: gitResult.channel,
            };
            const refLabel = gitSource.ref
              ? gitSource.ref === gitResult.resolvedSha
                ? gitSource.ref
                : `${gitSource.ref} → ${gitResult.resolvedSha.slice(0, 12)}`
              : `(default branch) → ${gitResult.resolvedSha.slice(0, 12)}`;
            // "Fetched", not "Installed" — this line prints before consent
            // (and under --dry-run); nothing has landed in the project yet
            // (#149a).
            console.log(
              pc.dim(
                `Fetched from git: ${gitSource.host}:${gitSource.owner}/${gitSource.repo}@${refLabel}${
                  gitSource.subpath ? "#" + gitSource.subpath : ""
                }`,
              ),
            );
          }
          if (remoteMatch) {
            const [, publisher, packSlug, requestedVersion] = remoteMatch;
            if (!publisher || !packSlug) {
              throw new Error("remote identity parse failed");
            }
            // The concrete version + manifest hash the content was actually
            // resolved to. The signature check below pins to these — not the
            // raw (possibly "latest") request — so a publish racing between
            // resolution and the signature fetch can't sign a different version
            // than the one being installed (code-reviewer finding, iter-9).
            let resolvedVersion: string | undefined;
            let resolvedManifestSha: string | undefined;
            let observedFiles: Array<{ path: string; sha256: string }> = [];
            try {
              const remote = await fetchRemotePack({
                publisher,
                pack: packSlug,
                requestedVersion,
                registry: options.registry,
                target: options.target,
                // Remote path still pre-fills "safe" for the signature-observed
                // file fetch; honoring exports.default_profile here too requires
                // resolving against the registry-served manifest and must be
                // verified against live infra (gated). The local path below
                // (planInstall) already resolves the declared default (#86).
                profile: options.profile ?? "safe",
                projectRoot: options.project,
              });
              source = remote.tmpRoot;
              resolvedVersion = remote.resolvedVersion;
              resolvedManifestSha = remote.manifestSha256;
              observedFiles = remote.observedFiles;
            } catch (err) {
              // Bare network errors ("fetch failed") give an agent nothing to
              // act on — say which registry was contacted and note the common
              // mistake (a typo'd local path matches the registry-id shape).
              const msg = err instanceof Error ? err.message : String(err);
              throw new Error(
                `Could not fetch \`${publisher}/${packSlug}\` from registry ${options.registry}: ${msg}\n` +
                  `  If you meant a local pack, pass its path (e.g. ./${publisher}/${packSlug}); ` +
                  `for a git repo use github:owner/repo[@ref][#subpath].`,
              );
            }
            sourceProvenance = {
              kind: "registry",
              id: `${publisher}/${packSlug}`,
              registry: options.registry.replace(/\/+$/, ""),
              requestedVersion: requestedVersion ?? null,
              resolvedVersion,
              // An exact requested version never moves; an omitted version
              // tracks the newest published release.
              channel: requestedVersion ? "pinned" : "latest",
            };

            // --require-sig: per ROADMAP exit-code taxonomy 0=ok, 2=drift,
            // 3=chain, 4=sig invalid, 5=unsigned-when-required. We enforce
            // BEFORE planInstall so a refused install touches zero files.
            if (options.requireSig) {
              const sigCheck = await verifyRegistrySignature({
                registry: options.registry,
                publisher,
                pack: packSlug,
                version: resolvedVersion,
                expectedManifestSha256: resolvedManifestSha,
                observedFiles,
              });
              if (sigCheck.code === "unsigned") {
                console.error(
                  pc.red(
                    `\n✗ ${publisher}/${packSlug}${requestedVersion ? "@" + requestedVersion : ""} is unsigned — --require-sig refuses.\n` +
                      `  To install anyway, rerun without --require-sig.`,
                  ),
                );
                process.exit(5);
              }
              if (sigCheck.code === "invalid") {
                console.error(
                  pc.red(
                    `\n✗ ${publisher}/${packSlug} signature INVALID — ${sigCheck.reason}${sigCheck.detail ? ` (${sigCheck.detail})` : ""}.\n` +
                      `  Refusing to install. If the publisher recently re-signed, try again.`,
                  ),
                );
                process.exit(4);
              }
              // Signature is cryptographically valid — now apply the
              // identity gate. A valid keyless signature only proves *some*
              // identity signed it; the gate pins the acceptable signer from
              // `--expected-signer` ∪ policy `install.allowedSigners`, and
              // (with policy `install.requireIdentity`) refuses an unpinned
              // signer rather than accepting it on trust-on-first-use
              // (ISC-289).
              const sigPolicy = await loadPolicy(options.project);
              const gate = signing.evaluateSignerGate({
                signerSan: sigCheck.san,
                expectedSigner: options.expectedSigner,
                allowedSigners: sigPolicy?.install.allowedSigners,
                requireIdentity: sigPolicy?.install.requireIdentity,
              });
              if (!gate.ok) {
                if (gate.reason === "identity_mismatch") {
                  console.error(
                    pc.red(
                      `\n✗ ${publisher}/${packSlug} signed by an UNTRUSTED identity — got ${gate.signerSan}, expected one of: ${gate.allowed.join(", ")}.\n` +
                        `  Refusing to install.`,
                    ),
                  );
                } else {
                  console.error(
                    pc.red(
                      `\n✗ ${publisher}/${packSlug} signature valid but signer identity is NOT pinned — policy requires a pinned identity.\n` +
                        `  Pass --expected-signer <san> or set install.allowedSigners in agentpack.policy.json (signer: ${gate.signerSan}).`,
                    ),
                  );
                }
                process.exit(4);
              }
              // The signature verified and the signer is acceptable — stash the
              // verified envelope so applyInstall persists it to the lockfile.
              verifiedSignatureB64 = sigCheck.envelopeB64;
              const coverageNote =
                sigCheck.coverage === "manifest-only"
                  ? pc.yellow(
                      " (legacy signature — covers AGENTPACK.yaml only, NOT atom file bytes; re-publish to get full-artifact coverage)",
                    )
                  : pc.dim(" (full-artifact coverage)");
              if (gate.mode === "pinned") {
                console.log(
                  pc.green(
                    `  ✓ signature verified — signed by ${gate.signerSan} (identity pinned)`,
                  ) + coverageNote,
                );
              } else {
                // Trust-on-first-use: valid signature, unpinned signer.
                // Never imply the publisher signed it.
                console.log(
                  pc.green(
                    `  ✓ signature cryptographically valid — signer: ${gate.signerSan}`,
                  ) + coverageNote,
                );
                console.log(
                  pc.yellow(
                    `  ⚠ signer identity NOT pinned — pass --expected-signer <san> or set install.allowedSigners in policy to require a specific identity.`,
                  ),
                );
              }
            }
          } else if (options.requireSig) {
            console.error(
              pc.red(
                "✗ --require-sig requires a remote pack identity (publisher/pack[@version]); local-path installs cannot be signature-checked.",
              ),
            );
            process.exit(2);
          }
          // Run recovery sweep on every real install — if a previous install
          // crashed, this is when we clean up. Idempotent on clean state.
          // Under --dry-run the sweep must NOT run: recovery writes (roll-
          // forward commit rows, rollback unlinks/restores), which would break
          // the dry run's zero-mutation contract (#123) — probe read-only and
          // surface pending recovery as a warning instead.
          let pendingRecovery = 0;
          if (options.dryRun) {
            try {
              pendingRecovery = await countIncompleteInstalls(options.project);
            } catch {
              // Non-fatal: directory may not exist yet (first install). Plan
              // will validate projectRoot below.
            }
          } else {
            try {
              await recoverIncomplete(options.project);
            } catch {
              // Non-fatal: directory may not exist yet (first install). Plan
              // will validate projectRoot below.
            }
          }
          const buildPlan = async (projectRoot: string) => {
            const built = await planInstall({
              source,
              target: options.target,
              // Don't pre-fill "safe": let exportPack resolve the pack's declared
              // exports.default_profile first, so imported packs (which declare
              // only `all`) install without an explicit --profile (#86).
              profile: options.profile,
              projectRoot,
              generator: { cli: CLI_VERSION, adapter: CLI_VERSION },
              ...(scope === "user" ? { scope: "user" as const } : {}),
            });
            // #35 fix 3: persist the verified signature envelope into the lockfile
            // so a later `verify --sig` recognizes the install as signed. The
            // envelope is base64-encoded JSON, matching what `verify --sig`
            // decodes from signatures.manifest.
            if (verifiedSignatureB64) {
              built.lockfile.signatures.manifest = verifiedSignatureB64;
            }
            // Sync S1: persist provenance into the lockfile; applyInstall
            // mirrors it into the install manifest. Absent for local paths.
            if (sourceProvenance) {
              built.lockfile.source = sourceProvenance;
            }
            return built;
          };
          let plan = await buildPlan(planProjectRoot);

          const planJson = () => ({
            packId: plan.packId,
            packVersion: plan.packVersion,
            target: plan.target,
            profile: plan.profile,
            riskLevel: plan.riskLevel,
            atoms: plan.atoms,
            warnings: plan.warnings,
            unsupportedAtoms: plan.unsupportedAtoms,
            // Two distinct compatibility surfaces (#134): the authored claim
            // (null when the manifest declares nothing for this target) and
            // the compiler-observed fidelity.
            authoredCompatibility: plan.authoredCompatibility ?? null,
            observedFidelity: plan.observedFidelity,
            files: {
              create: plan.created.map((f) => f.path),
              modify: plan.modified.map((f) => f.path),
              unchanged: plan.unchanged.map((f) => f.path),
              conflicts: plan.conflicts.map((c) => ({
                path: c.file.path,
                reason: c.reason,
                otherPackId: c.otherPackId,
              })),
              merges: plan.merges.map((m) => ({ path: m.path, strategy: m.strategy })),
            },
          });

          if (!options.json) {
            printPlanSummary(plan);
            if (projectMissing && !options.dryRun) {
              console.log(
                pc.yellow(
                  `\nProject directory ${options.project} does not exist — it will be created.`,
                ),
              );
            }
          }

          if (options.dryRun) {
            if (options.json) {
              console.log(
                JSON.stringify({
                  ...planJson(),
                  installed: false,
                  dryRun: true,
                  pendingRecovery,
                  ...(projectMissing ? { projectRootMissing: true } : {}),
                }),
              );
            } else {
              console.log(pc.dim("\n(--dry-run) No files were written."));
              if (projectMissing) {
                console.log(
                  pc.dim(
                    `Note: ${options.project} does not exist — a real install would create it; --dry-run never does.`,
                  ),
                );
              }
              if (pendingRecovery > 0) {
                console.log(
                  pc.yellow(
                    `⚠ ${pendingRecovery} incomplete install(s) pending crash recovery — skipped under --dry-run; recovery runs on the next real install.`,
                  ),
                );
              }
            }
            // Surface conflicts through the exit code so a probing agent can
            // detect them without parsing prose — same code the real install
            // path uses when it refuses.
            if (plan.conflicts.length > 0 && !options.force) process.exit(2);
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

          // Risk ceiling: a critical-risk plan never installs implicitly. A
          // single -y in a script (the documented CI path) must not be able
          // to cross it — the opt-in is explicit and greppable.
          if (plan.riskLevel === "critical" && !options.allowCritical) {
            if (options.json) {
              console.log(
                JSON.stringify({
                  ...planJson(),
                  installed: false,
                  error: "critical_risk_refused",
                  hint: "re-run with --allow-critical (intentionally separate from --yes)",
                }),
              );
            } else {
              console.error(
                pc.red(
                  `\n✗ Computed risk level is CRITICAL. Re-run with --allow-critical to proceed (this flag is intentionally separate from --yes).`,
                ),
              );
            }
            process.exit(ExitCode.PolicyViolation);
          }

          // Authored-compatibility gate (#134). A pack that declares this
          // target `partial` or `experimental` is telling the user up front
          // that the install degrades — that claim requires explicit
          // acknowledgement, mirroring --allow-critical: a single -y (the
          // documented CI path) must not cross it, so non-interactive runs
          // fail closed without the flag. Undeclared targets never gate.
          // (`unsupported` never reaches here — the planner refuses it.)
          const degradedTarget =
            plan.authoredCompatibility === "partial" ||
            plan.authoredCompatibility === "experimental";
          if (degradedTarget && !options.allowPartialTarget) {
            if (options.json) {
              console.log(
                JSON.stringify({
                  ...planJson(),
                  installed: false,
                  error: "partial_target_refused",
                  hint: "re-run with --allow-partial-target (intentionally separate from --yes)",
                }),
              );
            } else {
              console.error(
                pc.red(
                  `\n✗ This pack declares target \`${plan.target}\` ${String(plan.authoredCompatibility).toUpperCase()}. ` +
                    `Re-run with --allow-partial-target to acknowledge and proceed (this flag is intentionally separate from --yes).`,
                ),
              );
            }
            process.exit(ExitCode.PolicyViolation);
          }

          // Executable-surface gate (#63 / audit finding B1). A pack can ship
          // `hook` atoms (shell commands fired on agent lifecycle events) and
          // `mcp_server` atoms (launch configs like `node server.js` that run on
          // the user's next agent session). Either runs author-supplied code on
          // the user's machine. The command gate intentionally does NOT block a
          // legitimate interpreter running shipped code (that's what an
          // mcp_server IS), so the control here is provenance/consent, not the
          // gate.
          //
          // Rule: if the plan contains any hook/mcp_server atom AND the install
          // is NOT signature-verified, refuse unless --allow-exec is passed.
          // `verifiedSignatureB64` is set ONLY on the --require-sig success path
          // (a cryptographically valid signature whose signer passed the
          // identity gate), so its presence is the precise "provenance
          // established" marker — a signed install carrying exec atoms is NOT
          // gated. Git-sourced installs reject --require-sig outright, so they
          // are never verified and always fall under this gate. Like
          // --allow-critical, a single -y must not cross it: the opt-in is
          // explicit and greppable.
          const signatureVerified = verifiedSignatureB64 !== undefined;
          // Key off the authoritative typed atom list, NOT the `<type>:<slug>`
          // id prefix — an atom can declare an id prefix that differs from its
          // real `type`, which would let a mislabeled hook/mcp_server slip past
          // a prefix-based check. `plan.lockfile.atoms` is also unsuitable: it
          // collapses to a synthetic `*pack` entry when output files can't be
          // mapped back to atoms.
          const execAtoms = plan.atomTypes.filter(
            (a) => a.type === "hook" || a.type === "mcp_server",
          );
          // Second exec surface (#78): `command` and `subagent` atoms don't fire
          // on lifecycle events like hooks, but they compile to markdown whose
          // author prompt body is written VERBATIM. A Claude Code bang-bash
          // directive (`!`…`) in that body runs shell the moment the user
          // invokes the slash command / subagent — author-controlled code
          // reaching an exec surface, so it crosses the same consent gate.
          // Detect by scanning the exact bytes the plan will write (immune to
          // atom→file mapping drift). A benign prompt command (no `!`…`) is
          // NOT gated, so the common case (e.g. the README quickstart's
          // /pr-summary) stays frictionless.
          const BANG_BASH = /!`/;
          const plannedOutputs = [...plan.created, ...plan.modified, ...plan.unchanged];
          // --force also writes conflict files to disk (backed up first) —
          // they must clear the same consent scan. Excluding them let a
          // pre-existing user file at a command's path turn `--force -y` into
          // silent exec consent (#121 review, HIGH): the bang-bash scan is the
          // ONLY gate for command/subagent atoms, which are never execAtoms.
          if (options.force) plannedOutputs.push(...plan.conflicts.map((c) => c.file));
          // WHICH files to content-scan is declared by the ADAPTER — each
          // emitted file carries `execCapable` when its runtime executes
          // embedded directives (#119) — not by a path regex here. The flag
          // rides the file object through every path remap (e.g. --scope
          // user's `.claude/X` → `X`), so a layout change or a new
          // exec-capable target surface cannot silently detach this gate.
          const execFiles = plannedOutputs
            .filter((f) => f.execCapable === true && BANG_BASH.test(f.content))
            .map((f) => f.path);
          if (
            (execAtoms.length > 0 || execFiles.length > 0) &&
            !signatureVerified &&
            !options.allowExec
          ) {
            // Atom ids are already `<type>:<slug>` (schema-enforced), so the id
            // alone is the canonical label naming both the atom and its type.
            const labels = execAtoms.map((a) => a.id);
            if (options.json) {
              console.log(
                JSON.stringify({
                  ...planJson(),
                  installed: false,
                  error: "exec_atoms_refused",
                  ...(labels.length ? { execAtoms: labels } : {}),
                  ...(execFiles.length ? { execFiles } : {}),
                  hint: "re-run with --allow-exec (intentionally separate from --yes), or install a signed pack with --require-sig",
                }),
              );
            } else {
              console.error(
                pc.red(
                  `\n✗ This pack ships executable content and the install is NOT signature-verified:`,
                ),
              );
              for (const a of execAtoms) {
                const what =
                  a.type === "hook"
                    ? "shell command run on agent lifecycle events"
                    : "launch config run on your next agent session";
                console.error(pc.red(`  • ${a.id} (${a.type}) — ${what}`));
              }
              for (const f of execFiles) {
                console.error(
                  pc.red(
                    `  • ${f} — slash-command/agent body runs shell on invocation (\`!\`…\`\`)`,
                  ),
                );
              }
              console.error(
                pc.red(
                  `  Re-run with --allow-exec to proceed (intentionally separate from --yes).\n` +
                    `  A signed pack verified with --require-sig (registry source) would not require it.`,
                ),
              );
            }
            process.exit(ExitCode.PolicyViolation);
          }

          // Strict mode: a dropped atom (target-incompatible OR refused by a
          // security gate, e.g. a shell-escape MCP command) is collapsed into
          // `unsupportedAtoms`. Default install still succeeds — those atoms
          // simply don't apply to this target — but an agent that requires the
          // full requested surface can opt into treating any drop as failure.
          if (options.failOnUnsupported && plan.unsupportedAtoms.length > 0) {
            if (options.json) {
              console.log(
                JSON.stringify({
                  ...planJson(),
                  installed: false,
                  error: "unsupported_atoms",
                }),
              );
            } else {
              console.error(
                pc.red(
                  `\n✗ ${plan.unsupportedAtoms.length} selected atom(s) were not installed (${plan.unsupportedAtoms.join(", ")}). Aborting because --fail-on-unsupported was set.`,
                ),
              );
            }
            // Exit 2: same "won't proceed as requested" family as conflicts
            // and dry-run conflicts.
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
              process.exit(1);
            }
          }

          // #145: the user consented to the write plan (which announced the
          // directory creation) — only NOW may the directory come into being.
          // Re-plan against the real root: an empty fresh directory classifies
          // identically to the stand-in, but the plan carries absolute paths
          // that applyInstall writes to.
          if (projectMissing) {
            try {
              await fs.mkdir(projectAbs, { recursive: true });
            } catch (err) {
              console.error(
                pc.red(
                  `✗ Could not create project directory ${projectAbs}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                ),
              );
              process.exit(1);
            }
            plan = await buildPlan(options.project);
          }

          const result = await applyInstall({ plan, force: options.force });
          if (options.json) {
            console.log(
              JSON.stringify({
                ...planJson(),
                installed: true,
                written: result.written,
                manifestPath: result.manifestPath.replace(plan.projectRoot, "."),
                historyEntryId: result.commitEntry.id,
              }),
            );
            return;
          }
          console.log(
            pc.green(
              `\n✓ Installed ${plan.packId}@${plan.packVersion} (${plan.target}, ${plan.profile}).`,
            ),
          );
          printOrientation(plan, scope);
          // Reconcile with the plan: `result.written` includes AGENTPACK.lock,
          // which the plan's Create list never shows — report it separately so
          // the counts agree (#149b).
          const payloadWritten = result.written.filter((p) => p !== LOCKFILE_NAME);
          console.log(pc.dim(`  • ${payloadWritten.length} files + lockfile written.`));
          if (plan.unsupportedAtoms.length > 0) {
            console.log(
              pc.yellow(
                `  ⚠ ${plan.unsupportedAtoms.length} atom(s) NOT installed (target-incompatible or refused by a security gate): ${plan.unsupportedAtoms.join(", ")}. See warnings above; re-run with --fail-on-unsupported to treat this as an error.`,
              ),
            );
          }
          console.log(
            pc.dim(`  • Manifest: ${result.manifestPath.replace(plan.projectRoot, ".")}`),
          );
          console.log(pc.dim(`  • History entry: ${result.commitEntry.id}`));
          if (scope === "user") {
            console.log(
              pc.dim(
                `\nUser-scope install: files live under ~/.claude, state under ~/.claude/.agentpack/.\nKeep the pack repo as the source of truth; run \`agentpack update --scope user\` to pull its changes.`,
              ),
            );
          } else {
            console.log(
              pc.dim(
                `\nConsider adding to .gitignore:\n  .agentpack/installed/\n  .agentpack/backups/\n  .agentpack/history.jsonl\n  .agentpack/.lock\nKeep \`AGENTPACK.lock\` committed for reproducibility.`,
              ),
            );
          }
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
}): Promise<{
  tmpRoot: string;
  resolvedVersion: string;
  manifestSha256: string;
  /**
   * sha256 of the ACTUAL bytes written for every non-manifest file (#35). Used
   * to verify downloads against the SIGNED release descriptor rather than the
   * registry-served per-file metadata.
   */
  observedFiles: Array<{ path: string; sha256: string }>;
}> {
  const registry = params.registry.replace(/\/+$/, "");
  const token = (await getToken(registry)) ?? undefined;
  const client: RegistryClient = new HttpRegistryClient({
    baseUrl: registry,
    token,
  });

  // 1. Resolve version.
  let version = params.requestedVersion;
  if (!version) {
    const latest = await latestPublishedVersion(client, params.publisher, params.pack);
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
    const versionDetails = await client.getVersion(params.publisher, params.pack, version);
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
  const versionMeta = await client.getVersion(params.publisher, params.pack, version);
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `agentpack-${params.publisher}-${params.pack}-`),
  );

  const manifestBytes = Buffer.from(
    await client.fetchManifest(params.publisher, params.pack, version),
    "utf-8",
  );
  // Integrity-check the manifest against the registry's recorded hash — atom
  // files already get this treatment, and the manifest drives atom
  // resolution, the risk summary the user consents to, and the lockfile
  // checksum (security-reviewer MEDIUM-1).
  const actualManifestSha = createHash("sha256").update(manifestBytes).digest("hex");
  if (actualManifestSha !== versionMeta.manifestSha256) {
    throw new IntegrityError(
      versionMeta.manifestSha256,
      actualManifestSha,
      "AGENTPACK.yaml",
    );
  }
  await fs.writeFile(path.join(tmpRoot, "AGENTPACK.yaml"), manifestBytes);

  const observedFiles: Array<{ path: string; sha256: string }> = [];
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
      // Hash the ACTUAL bytes we wrote (#35). client.fetchAtomFile checks bytes
      // against the registry-served `file.sha256`; that does NOT catch a
      // compromised registry serving a malicious hash that matches malicious
      // bytes. The release-descriptor check below compares this to the SIGNED
      // digest set, which a registry/R2 swap cannot forge.
      observedFiles.push({
        path: file.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
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

  // "Fetched", not "Installed" — same pre-consent accuracy as the git line
  // (#149a): at this point the pack is only materialized into a tmpdir.
  console.log(
    pc.dim(`Fetched from registry: ${params.publisher}/${params.pack}@${version}`),
  );
  return {
    tmpRoot,
    resolvedVersion: version,
    manifestSha256: actualManifestSha,
    observedFiles,
  };
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
  publisher: string,
  pack: string,
  version: string,
  file: { path: string; sha256: string; bytes: number },
): Promise<Buffer> {
  // The registry client has no fetch path for files without an atom id yet.
  // Writing an empty buffer here would silently corrupt the install (the
  // lockfile would pin a hash for a file whose bytes were discarded) — fail
  // loudly instead until the client grows a by-path fetch (codex P1-4).
  throw new Error(
    `Registry version ${publisher}/${pack}@${version} contains a non-atom file \`${file.path}\` that this CLI cannot fetch yet. Install from the pack's git source instead.`,
  );
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
  /** Base64 envelope to persist into the lockfile (#35 fix 3). */
  envelopeB64: string;
  /** full-artifact = v2 descriptor verified; manifest-only = legacy v1. */
  coverage: "full-artifact" | "manifest-only";
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
  /**
   * sha256 of the manifest actually materialized on disk. When provided, the
   * signed checksum the registry serves MUST equal it — otherwise the
   * signature is over different content than what's being installed (e.g. a
   * stale `latest` pointer) and is rejected.
   */
  expectedManifestSha256?: string | undefined;
  /**
   * sha256 of the ACTUAL bytes downloaded for every non-manifest file (#35).
   * Checked against the SIGNED release descriptor so a registry/R2 swap of atom
   * bytes (with a matching malicious per-file hash) is rejected.
   */
  observedFiles: Array<{ path: string; sha256: string }>;
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
      releaseDescriptor?: signing.ReleaseDescriptor;
      metadata: signing.SignatureMetadata;
    }>;
  };
  if (data.signatures.length === 0) return { code: "unsigned" };

  // Tie the signature to the bytes on disk: the checksum the registry signed
  // must equal the manifest we actually materialized. Without this, a `latest`
  // pointer that advanced between content fetch and signature fetch would let a
  // signature for a *different* version pass as if it covered the install.
  if (
    params.expectedManifestSha256 &&
    data.manifestSha256 !== params.expectedManifestSha256
  ) {
    return {
      code: "invalid",
      reason: "manifest_mismatch",
      detail: `signed manifest ${data.manifestSha256.slice(0, 12)}… does not match the installed manifest ${params.expectedManifestSha256.slice(0, 12)}…`,
    };
  }

  // Verify the newest signature (registry sorts newest-first).
  const latest = data.signatures[0];
  if (!latest) return { code: "unsigned" };
  // Reconstruct the envelope as served by the registry. A v2 envelope carries
  // the release descriptor; a legacy v1 row does not.
  const envelopeVersion: 1 | 2 = latest.envelopeVersion === 2 ? 2 : 1;
  const envelope: signing.SignedManifest = {
    manifestChecksum: latest.manifestChecksum,
    bundleB64: latest.bundleB64,
    metadata: latest.metadata,
    envelopeVersion,
    ...(latest.releaseDescriptor ? { releaseDescriptor: latest.releaseDescriptor } : {}),
  };
  // Full-artifact verification (#35). For a v2 envelope this confirms the
  // bundle signs the release-descriptor digest AND that every downloaded file
  // matches the SIGNED digest set — a registry/R2 byte swap cannot pass even if
  // the served per-file metadata was forged to match. For a legacy v1 envelope
  // it falls back to manifest-only coverage. The identity decision (is this
  // signer *trusted*?) is applied by the caller via `evaluateSignerGate`.
  const result = await signing.verifyReleaseSignature({
    manifestSha256: data.manifestSha256,
    observedFiles: params.observedFiles,
    signed: envelope,
  });
  if (result.valid) {
    const envelopeB64 = Buffer.from(JSON.stringify(envelope), "utf-8").toString("base64");
    return {
      code: "ok",
      san: result.metadata.identity.san,
      envelopeB64,
      coverage: result.coverage,
    };
  }
  return {
    code: "invalid",
    reason: result.reason,
    detail: result.detail,
  };
}

const RUNTIME_NAMES: Record<TargetPlatform, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  chatgpt: "ChatGPT",
  generic: "your agent runtime",
};

/** Where each target's adapter merges instruction/rule guidance. */
const INSTRUCTIONS_FILE: Record<TargetPlatform, string> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
  cursor: "AGENTS.md",
  chatgpt: "project-instructions.md",
  generic: "AGENTS.md",
};

/**
 * Post-install orientation (#148): what the user gained, grouped by atom kind
 * with names, then the one line that says where to use it. Derived from the
 * plan's resolved atoms — dropped (unsupported) atoms are never listed, and
 * kinds that aren't present don't print. Plumbing notes come after this.
 */
function printOrientation(
  plan: ReturnType<typeof planInstall> extends Promise<infer T> ? T : never,
  scope: "project" | "user",
): void {
  const dropped = new Set(plan.unsupportedAtoms);
  const slug = (id: string) => (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);
  const byType = new Map<string, string[]>();
  for (const a of plan.atomTypes) {
    if (dropped.has(a.id)) continue;
    const list = byType.get(a.type) ?? [];
    list.push(slug(a.id));
    byType.set(a.type, list);
  }
  const lines: string[] = [];
  const add = (label: string, names: string[] | undefined) => {
    if (names && names.length > 0) lines.push(`  ${label}: ${names.join(", ")}`);
  };
  add(
    "Commands",
    byType.get("command")?.map((s) => `/${s}`),
  );
  add("Skills", byType.get("skill"));
  add("Agents", byType.get("subagent"));
  // instruction + rule atoms both merge into the target's shared guidance file.
  const guidance = [...(byType.get("instruction") ?? []), ...(byType.get("rule") ?? [])];
  if (guidance.length > 0) {
    lines.push(`  ${INSTRUCTIONS_FILE[plan.target]}: ${guidance.join(", ")} (merged)`);
  }
  add("Hooks", byType.get("hook"));
  add("MCP servers", byType.get("mcp_server"));
  const namedKinds = new Set([
    "command",
    "skill",
    "subagent",
    "instruction",
    "rule",
    "hook",
    "mcp_server",
  ]);
  const other = [...byType.entries()]
    .filter(([t]) => !namedKinds.has(t))
    .flatMap(([t, names]) => names.map((n) => `${n} (${t})`));
  if (other.length > 0) lines.push(`  Also: ${other.join(", ")}`);
  if (lines.length === 0) return;
  console.log("\nYou now have:");
  for (const l of lines) console.log(l);
  const runtime = RUNTIME_NAMES[plan.target];
  console.log(
    scope === "user"
      ? `Open ${runtime} to use them — user scope applies in every project.`
      : `Open this project in ${runtime} to use them.`,
  );
}

function printPlanSummary(
  plan: ReturnType<typeof planInstall> extends Promise<infer T> ? T : never,
): void {
  console.log(
    pc.bold(
      `\nInstall plan: ${plan.packId}@${plan.packVersion} → ${plan.target} (${plan.profile})`,
    ),
  );
  console.log(`Risk: ${riskBadge(plan.riskLevel)}`);
  // Authored claim vs compiler-observed result, side by side (#134) — an
  // authored "supported" must never mask a degraded observation.
  console.log(
    `Compatibility: authored ${plan.authoredCompatibility ?? "(undeclared)"} · observed ${plan.observedFidelity}`,
  );
  console.log(pc.bold(`\nPermissions:`));
  console.log(renderPermissionSummary(plan.permissions));
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
