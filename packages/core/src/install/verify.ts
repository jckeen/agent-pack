import * as fs from "node:fs/promises";
import type { VerifyResult } from "./types.js";
import type { AgentpackPaths } from "./paths.js";
import { resolveAgentpackPaths, fromRelative } from "./paths.js";
import { readInstallManifest } from "./manifest.js";
import { parseLockfileDocument, lockfileEntryChecksum } from "./lockfile.js";
import { normalizeForHash, sha256Hex } from "./checksum.js";
import { readHistory, verifyChain } from "./history.js";
import { extractMarkerSpan, jsonFragmentIntact } from "./merge.js";

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
  const ws = await resolveAgentpackPaths(opts.projectRoot);
  const manifest = await readInstallManifest(ws, opts.packId);

  // Cross-check: lockfile checksum recorded at install vs. this pack's entry
  // in the current (multi-pack, #114) lockfile. The per-pack checksum hashes
  // the entry rendered as a standalone v1 document, so another pack's
  // install/uninstall never shifts it, and manifests written by pre-v2 CLIs
  // (which hashed the whole single-pack v1 file — the same bytes) stay valid.
  // A lockfile with NO entry for this pack is the expected legacy state of a
  // multi-pack project whose lockfile was last written single-pack, not
  // drift.
  const lockfileRaw = await fs.readFile(ws.lockfilePath, "utf8").catch(() => "");
  let lockfileDrift = false;
  let lockfileActual = "<missing>";
  if (lockfileRaw !== "") {
    try {
      const doc = parseLockfileDocument(lockfileRaw);
      const entry = doc.packs[manifest.packId];
      if (entry) {
        lockfileActual = lockfileEntryChecksum(entry);
        lockfileDrift = lockfileActual !== manifest.lockfileChecksum;
      }
    } catch {
      // Unparseable lockfile bytes are a tamper/corruption signal for
      // whichever pack is being verified — can't attribute ownership.
      lockfileDrift = true;
      lockfileActual = sha256Hex(lockfileRaw);
    }
  }

  const drift: VerifyResult["drift"] = [];
  const missing: string[] = [];

  const mergeByPath = new Map((manifest.merges ?? []).map((m) => [m.path, m]));

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
    // Merged files (shared CLAUDE.md / settings.json / .mcp.json) are checked
    // at FRAGMENT level: only the pack's contribution must be intact. The
    // user editing their own sections of a shared file is not drift.
    const merge = mergeByPath.get(entry.path);
    if (merge?.strategy === "marker") {
      const span = extractMarkerSpan(current, manifest.packId);
      const actual = span
        ? sha256Hex(normalizeForHash(`${span.span}\n`))
        : "<span-missing>";
      if (actual !== merge.fragmentSha256) {
        drift.push({ path: entry.path, expected: merge.fragmentSha256, actual });
      }
      continue;
    }
    if (merge?.strategy === "json") {
      if (!jsonFragmentIntact(current, merge.fragment)) {
        drift.push({
          path: entry.path,
          expected: merge.fragmentSha256,
          actual: "<fragment-altered>",
        });
      }
      continue;
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
      actual: lockfileActual,
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

export { resolveAgentpackPaths };
export type { AgentpackPaths };
