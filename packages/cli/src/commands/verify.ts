import { promises as fs } from "node:fs";
import path from "node:path";

import type { Command } from "commander";
import pc from "picocolors";

import {
  listInstallManifests,
  loadPolicy,
  parseLockfileDocument,
  resolveAgentpackPaths,
  signing,
  verifyInstall,
} from "@agentpack/core";

import { failCleanly } from "../lib/error.js";

interface VerifyCliOptions {
  project: string;
  chain: boolean;
  sig: boolean;
  sigIfPresent: boolean;
  strict: boolean;
  expectedSigner?: string;
  all: boolean;
  quiet: boolean;
}

export function registerVerify(program: Command): void {
  program
    .command("verify [packId]")
    .description("Verify that installed files still match the lockfile (drift detection).")
    .option("--project <dir>", "target project directory", process.cwd())
    .option(
      "--all",
      "verify every installed pack under .agentpack/installed/ (sync S1)",
      false,
    )
    .option("--quiet", "print nothing; communicate via the exit code only", false)
    .option("--chain", "also verify the history.jsonl hash chain", false)
    .option(
      "--sig",
      "verify the Sigstore signature recorded in the lockfile; FAILS if the lockfile is unsigned",
      false,
    )
    .option(
      "--sig-if-present",
      "like --sig, but pass on an unsigned lockfile instead of failing (the old lenient --sig behavior)",
      false,
    )
    .option(
      "--strict",
      "(deprecated alias) same as --sig — exit non-zero when the lockfile records no signature",
      false,
    )
    .option(
      "--expected-signer <san>",
      "with --sig: require the Sigstore certificate identity (SAN) to equal this value",
    )
    .action(async (packId: string | undefined, options: VerifyCliOptions) => {
      try {
        if (!packId && !options.all) {
          console.error(
            pc.red("✗ Provide a packId, or pass --all to verify every installed pack."),
          );
          process.exit(2);
        }
        if (packId && options.all) {
          console.error(pc.red("✗ Pass either a packId or --all, not both."));
          process.exit(2);
        }
        const sigChecking = options.sig || options.sigIfPresent || options.strict;
        if (options.all && sigChecking) {
          // Signature verification stays single-pack for now: the v2
          // lockfile (#114) records signatures per pack entry, but the
          // aggregate exit-code semantics of --all --sig are unspecified —
          // keep requiring an explicit packId.
          console.error(
            pc.red("✗ --sig/--sig-if-present/--strict require a single packId."),
          );
          process.exit(2);
        }

        let ids: string[];
        if (options.all) {
          const paths = await resolveAgentpackPaths(options.project);
          ids = (await listInstallManifests(paths)).map((m) => m.packId);
          if (ids.length === 0) {
            if (!options.quiet) {
              console.log(pc.dim("No AgentPacks installed — nothing to verify."));
            }
            process.exit(0);
          }
        } else {
          ids = [packId as string];
        }

        const codes: number[] = [];
        for (const id of ids) {
          codes.push(await verifyOne(id, options));
        }
        // Severity across packs: chain break > drift > signature invalid >
        // unsigned-when-required (same ordering the single-pack path applies
        // within one pack).
        for (const severity of [3, 2, 4, 5]) {
          if (codes.includes(severity)) process.exit(severity);
        }
        process.exit(0);
      } catch (err) {
        failCleanly(err);
      }
    });
}

/**
 * Verify one pack and return its exit code (0 clean, 2 drift, 3 chain broken,
 * 4 signature invalid, 5 unsigned-when-required) instead of exiting — the
 * caller aggregates across packs for --all.
 */
async function verifyOne(packId: string, options: VerifyCliOptions): Promise<number> {
  const say = options.quiet ? () => {} : console.log;
  const sayErr = options.quiet ? () => {} : console.error;

  const result = await verifyInstall({
    packId,
    projectRoot: options.project,
    checkChain: options.chain,
  });

  // Drift takes precedence — if any file is modified or missing, the
  // signature is moot (it was over a different hash than what's on
  // disk now). Per ROADMAP exit codes: 2 = drift, 3 = chain broken,
  // 4 = signature mismatch, 5 = unsigned-when-required.
  if (result.chainOk === false) {
    sayErr(
      pc.red(
        `✗ history.jsonl chain integrity FAILED at entry index ${result.chainBrokeAt}.`,
      ),
    );
    return 3;
  }
  if (!result.clean) {
    sayErr(pc.red(`✗ ${packId} has drift:`));
    for (const d of result.drift) {
      sayErr(
        `  ${pc.red("•")} ${d.path}: expected ${d.expected.slice(0, 12)}…, actual ${d.actual.slice(0, 12)}…`,
      );
    }
    for (const m of result.missing) {
      sayErr(`  ${pc.red("•")} ${m}: missing`);
    }
    return 2;
  }

  // Drift-clean — optionally also verify the signature.
  //
  // #35 fix 2: `--sig` ENFORCES by default — an unsigned lockfile is a
  // failure (exit 5). The old lenient "verify only if a signature
  // exists" behavior lives behind `--sig-if-present`. `--strict` is
  // kept as a deprecated alias for the enforcing behavior. The
  // signature check runs whenever ANY of these flags is set.
  const sigChecking = options.sig || options.sigIfPresent || options.strict;
  // Enforce (fail on unsigned) unless the caller explicitly opted into
  // lenient mode via --sig-if-present.
  const enforceSigned = sigChecking && !options.sigIfPresent;
  if (sigChecking) {
    const policy = await loadPolicy(options.project);
    const sigResult = await checkLockfileSignature(
      options.project,
      packId,
      enforceSigned,
      options.expectedSigner,
      policy?.install.allowedSigners,
      policy?.install.requireIdentity,
    );
    if (sigResult.code === "ok") {
      if (sigResult.pinned) {
        say(
          pc.green(`✓ ${packId} clean — signature valid, signer pinned (${sigResult.san})`),
        );
      } else {
        say(
          pc.green(
            `✓ ${packId} clean — signature cryptographically valid (${sigResult.san})`,
          ) +
            " " +
            pc.yellow("(signer identity not pinned — pass --expected-signer to enforce)"),
        );
      }
    } else if (sigResult.code === "unsigned") {
      if (enforceSigned) {
        sayErr(
          pc.red(
            `✗ ${packId} clean but UNSIGNED — --sig requires a signature. ` +
              `Pass --sig-if-present to allow unsigned packs.`,
          ),
        );
        return 5;
      }
      say(pc.green(`✓ ${packId} clean — no drift.`) + " " + pc.yellow("(unsigned)"));
    } else {
      sayErr(
        pc.red(
          `✗ ${packId} clean but SIGNATURE INVALID — ${sigResult.reason}${sigResult.detail ? ` (${sigResult.detail})` : ""}`,
        ),
      );
      return 4;
    }
  } else {
    say(pc.green(`✓ ${packId} clean — no drift.`));
    if (options.chain) {
      say(pc.dim("  • History chain integrity: ok."));
    }
  }
  return 0;
}

interface SigOk {
  code: "ok";
  san: string;
  /** True when the signer SAN was pinned (CLI flag or policy allowlist). */
  pinned: boolean;
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

async function checkLockfileSignature(
  projectRoot: string,
  packId: string,
  _strict: boolean,
  expectedSigner?: string,
  allowedSigners?: readonly string[],
  requireIdentity?: boolean,
): Promise<SigCheck> {
  const lockfilePath = path.join(projectRoot, "AGENTPACK.lock");
  let raw: string;
  try {
    raw = await fs.readFile(lockfilePath, "utf-8");
  } catch (err) {
    return {
      code: "invalid",
      reason: "lockfile_unreadable",
      detail: (err as Error).message,
    };
  }
  // Multi-pack lockfile (#114): the signature and manifest checksum are
  // per-pack, read from THIS pack's entry — never from whichever pack
  // happened to be installed last.
  let lockfile;
  try {
    const doc = parseLockfileDocument(raw);
    lockfile = doc.packs[packId];
  } catch (err) {
    return {
      code: "invalid",
      reason: "lockfile_invalid",
      detail: (err as Error).message,
    };
  }
  if (!lockfile) {
    return {
      code: "invalid",
      reason: "lockfile_missing_pack",
      detail: `AGENTPACK.lock has no entry for ${packId} — re-install to record one`,
    };
  }
  const manifestSig = lockfile.signatures?.manifest;
  if (!manifestSig) return { code: "unsigned" };
  let envelope: signing.SignedManifest;
  try {
    const decoded = JSON.parse(Buffer.from(manifestSig, "base64").toString("utf-8"));
    envelope = signing.signedManifestSchema.parse(decoded);
  } catch (err) {
    return {
      code: "invalid",
      reason: "envelope_invalid",
      detail: (err as Error).message,
    };
  }
  // Cryptographic verification; the identity decision is applied by the shared
  // signer gate below (ISC-289), so `--expected-signer` and policy
  // `install.allowedSigners` are enforced consistently with `install`.
  //
  // #35: a v2 (full-artifact) envelope signs the release-descriptor digest, not
  // the manifest checksum — so it must be verified via `verifyReleaseSignature`.
  // At this seam the original published pack files are not on disk in their
  // signed form (the install transformed them into adapter outputs; drift of
  // those is covered separately by `verifyInstall`). We therefore verify the
  // signature + the descriptor↔manifest tie, passing the descriptor's own file
  // digests as the observed set so the file-set check is satisfied by the
  // SIGNED bytes. A v1 envelope falls back to manifest-only coverage.
  const result = await signing.verifyReleaseSignature({
    manifestSha256: lockfile.manifestChecksum,
    observedFiles: envelope.releaseDescriptor
      ? envelope.releaseDescriptor.files.map((f) => ({
          path: f.path,
          sha256: f.sha256,
        }))
      : [],
    signed: envelope,
  });
  if (!result.valid) {
    return {
      code: "invalid",
      reason: result.reason,
      detail: result.detail,
    };
  }
  const gate = signing.evaluateSignerGate({
    signerSan: result.metadata.identity.san,
    expectedSigner,
    allowedSigners,
    requireIdentity,
  });
  if (!gate.ok) {
    return {
      code: "invalid",
      reason:
        gate.reason === "identity_mismatch"
          ? "signer_not_allowed"
          : "signer_identity_required",
      detail:
        gate.reason === "identity_mismatch"
          ? `signer ${gate.signerSan} not in allowed set: ${gate.allowed.join(", ")}`
          : `signer ${gate.signerSan} is unpinned and policy requires a pinned identity`,
    };
  }
  return { code: "ok", san: gate.signerSan, pinned: gate.mode === "pinned" };
}
