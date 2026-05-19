import { promises as fs } from "node:fs";
import path from "node:path";

import type { Command } from "commander";
import pc from "picocolors";

import {
  parseLockfile,
  signing,
  verifyInstall,
} from "@agentpack/core";

import { failCleanly } from "../lib/error.js";

export function registerVerify(program: Command): void {
  program
    .command("verify <packId>")
    .description(
      "Verify that installed files still match the lockfile (drift detection)."
    )
    .option("--project <dir>", "target project directory", process.cwd())
    .option("--chain", "also verify the history.jsonl hash chain", false)
    .option(
      "--sig",
      "also verify the Sigstore signature recorded in the lockfile",
      false
    )
    .option(
      "--strict",
      "with --sig, exit non-zero if the lockfile records no signature",
      false
    )
    .action(
      async (
        packId: string,
        options: { project: string; chain: boolean; sig: boolean; strict: boolean }
      ) => {
        try {
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
            console.error(
              pc.red(
                `✗ history.jsonl chain integrity FAILED at entry index ${result.chainBrokeAt}.`
              )
            );
            process.exit(3);
          }
          if (!result.clean) {
            console.error(pc.red(`✗ ${packId} has drift:`));
            for (const d of result.drift) {
              console.error(
                `  ${pc.red("•")} ${d.path}: expected ${d.expected.slice(0, 12)}…, actual ${d.actual.slice(0, 12)}…`
              );
            }
            for (const m of result.missing) {
              console.error(`  ${pc.red("•")} ${m}: missing`);
            }
            process.exit(2);
          }

          // Drift-clean — optionally also verify the signature.
          if (options.sig) {
            const sigResult = await checkLockfileSignature(
              options.project,
              packId,
              options.strict
            );
            if (sigResult.code === "ok") {
              console.log(
                pc.green(
                  `✓ ${packId} clean — signature valid (${sigResult.san})`
                )
              );
            } else if (sigResult.code === "unsigned") {
              if (options.strict) {
                console.error(
                  pc.red(
                    `✗ ${packId} clean but UNSIGNED — --strict refuses unsigned packs.`
                  )
                );
                process.exit(5);
              }
              console.log(
                pc.green(`✓ ${packId} clean — no drift.`) +
                  " " +
                  pc.yellow("(unsigned)")
              );
            } else {
              console.error(
                pc.red(
                  `✗ ${packId} clean but SIGNATURE INVALID — ${sigResult.reason}${sigResult.detail ? ` (${sigResult.detail})` : ""}`
                )
              );
              process.exit(4);
            }
          } else {
            console.log(pc.green(`✓ ${packId} clean — no drift.`));
            if (options.chain) {
              console.log(pc.dim("  • History chain integrity: ok."));
            }
          }
          process.exit(0);
        } catch (err) {
          failCleanly(err);
        }
      }
    );
}

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

async function checkLockfileSignature(
  projectRoot: string,
  _packId: string,
  _strict: boolean
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
  let lockfile;
  try {
    lockfile = parseLockfile(raw);
  } catch (err) {
    return {
      code: "invalid",
      reason: "lockfile_invalid",
      detail: (err as Error).message,
    };
  }
  const manifestSig = lockfile.signatures?.manifest;
  if (!manifestSig) return { code: "unsigned" };
  let envelope: signing.SignedManifest;
  try {
    const decoded = JSON.parse(
      Buffer.from(manifestSig, "base64").toString("utf-8")
    );
    envelope = signing.signedManifestSchema.parse(decoded);
  } catch (err) {
    return {
      code: "invalid",
      reason: "envelope_invalid",
      detail: (err as Error).message,
    };
  }
  const result = await signing.verifyManifestSignature({
    manifestChecksum: lockfile.manifestChecksum,
    signed: envelope,
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
