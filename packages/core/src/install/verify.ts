import * as fs from "node:fs/promises";
import type { VerifyResult } from "./types.js";
import type { WorkgraphPaths } from "./paths.js";
import { resolveWorkgraphPaths, fromRelative } from "./paths.js";
import { readInstallManifest } from "./manifest.js";
import { parseLockfile } from "./lockfile.js";
import { normalizeForHash, sha256Hex } from "./checksum.js";
import { readHistory, verifyChain } from "./history.js";

export interface VerifyOptions {
  packId: string;
  projectRoot: string;
  /** Also verify the history.jsonl hash chain. */
  checkChain?: boolean;
}

/**
 * Compute drift between the install manifest's recorded checksums and the
 * actual on-disk files. Tracks every `created[]` and `modified[]` path.
 *
 * Returns `{ clean: true, drift: [], missing: [] }` when everything matches.
 * `chainOk` is set only when `checkChain` is true.
 */
export async function verifyInstall(opts: VerifyOptions): Promise<VerifyResult> {
  const ws = await resolveWorkgraphPaths(opts.projectRoot);
  const manifest = await readInstallManifest(ws, opts.packId);

  // Cross-check: lockfile checksum recorded at install vs. current lockfile
  // bytes. A drift here means the user mutated AGENTPACK.lock manually.
  const lockfileRaw = await fs.readFile(ws.lockfilePath, "utf8").catch(() => "");
  let lockfileDrift = false;
  if (lockfileRaw !== "") {
    try {
      parseLockfile(lockfileRaw);
      const currentLockfileSha = sha256Hex(lockfileRaw);
      lockfileDrift = currentLockfileSha !== manifest.lockfileChecksum;
    } catch {
      lockfileDrift = true;
    }
  }

  const drift: VerifyResult["drift"] = [];
  const missing: string[] = [];

  for (const entry of [...manifest.created, ...manifest.modified]) {
    const abs = fromRelative(ws.projectRoot, entry.path);
    let current: string;
    try {
      current = await fs.readFile(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(entry.path);
        continue;
      }
      throw err;
    }
    const sha = sha256Hex(normalizeForHash(current));
    if (sha !== entry.sha256) {
      drift.push({ path: entry.path, expected: entry.sha256, actual: sha });
    }
  }

  if (lockfileDrift) {
    drift.push({
      path: "AGENTPACK.lock",
      expected: manifest.lockfileChecksum,
      actual: lockfileRaw === "" ? "<missing>" : sha256Hex(lockfileRaw),
    });
  }

  let chainOk: boolean | undefined;
  let chainBrokeAt: number | undefined;
  if (opts.checkChain) {
    const entries = await readHistory(ws);
    const r = verifyChain(entries);
    if (r.ok) {
      chainOk = true;
    } else {
      chainOk = false;
      chainBrokeAt = r.brokeAt;
    }
  }

  return {
    packId: opts.packId,
    clean: drift.length === 0 && missing.length === 0,
    drift,
    missing,
    chainOk,
    chainBrokeAt,
  };
}

export { resolveWorkgraphPaths };
export type { WorkgraphPaths };
