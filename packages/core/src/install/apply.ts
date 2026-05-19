import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { InstallPlanV2, InstallManifestV1, HistoryEntryV1 } from "./types.js";
import type { AgentpackPaths } from "./paths.js";
import {
  resolveAgentpackPaths,
  ensureAgentpackDirs,
  realpathContained,
  toRelative,
  backupDirForInstall,
} from "./paths.js";
import {
  InstallManifestNotFoundError,
  readInstallManifest,
  writeInstallManifest,
} from "./manifest.js";
import { recordHistory, newHistoryId, withProjectLock } from "./history.js";
import { serializeLockfile, lockfileChecksum } from "./lockfile.js";
import { sha256Hex, normalizeForHash } from "./checksum.js";

export interface ApplyInstallOptions {
  plan: InstallPlanV2;
  /**
   * If true, install proceeds even when `plan.conflicts.length > 0`.
   * Conflicting files are backed up.
   */
  force?: boolean;
  /** Caller identifier for the history actor. */
  actor?: { type: "cli" | "ci" | "agent"; id?: string };
}

export interface ApplyInstallResult {
  manifestPath: string;
  /** Project-relative paths written. */
  written: string[];
  /** History entry for the install_commit row. */
  commitEntry: HistoryEntryV1;
}

/**
 * Apply an install plan to disk.
 *
 *   1. WAL: write `install_begin` history entry with plannedFiles[] BEFORE
 *      any project file is touched.
 *   2. For every `modified` and `conflict` (under --force) target, copy the
 *      existing file to `.agentpack/backups/<packId>/<ts>.<nonce>/...`.
 *   3. Write every staged file atomically (write to .tmp, fsync, rename).
 *   4. Write AGENTPACK.lock at projectRoot.
 *   5. Write `.agentpack/installed/<packId>.json`.
 *   6. WAL: write `install_commit` history entry.
 *
 * If any step fails between begin and commit, the begin entry is left in
 * place — the next CLI invocation's recovery sweep will roll forward (if all
 * staged files match) or roll back.
 */
export async function applyInstall(opts: ApplyInstallOptions): Promise<ApplyInstallResult> {
  const plan = opts.plan;
  if (plan.conflicts.length > 0 && !opts.force) {
    const paths = plan.conflicts.map((c) => `  • ${c.file.path} (${c.reason})`).join("\n");
    throw new Error(
      `Install refused: ${plan.conflicts.length} conflict(s) (no AgentPack marker or marker belongs to another pack):\n${paths}\nPass --force to back up and overwrite.`,
    );
  }
  const ws = await resolveAgentpackPaths(plan.projectRoot);
  await ensureAgentpackDirs(ws);
  // Serialize the entire install (plan → write → commit) against any other
  // concurrent `agentpack install` running against the same projectRoot.
  // Without this, two concurrent installs both pass `plan` and clash on
  // `atomicWriteFile(..., "wx")`, leaving an orphan `install_begin` row.
  // Reentrant: `recordHistory` calls inside the locked region detect the
  // outer hold and skip re-acquiring. From qa-lead HIGH-3 (iter-5).
  return withProjectLock(ws, async () => applyInstallLocked(opts, ws));
}

async function applyInstallLocked(
  opts: ApplyInstallOptions,
  ws: import("./paths.js").AgentpackPaths,
): Promise<ApplyInstallResult> {
  const plan = opts.plan;

  // 1. WAL begin
  const beginEntry = await recordHistory(ws, {
    id: newHistoryId(),
    action: "install_begin",
    timestamp: new Date().toISOString(),
    packId: plan.packId,
    packVersion: plan.packVersion,
    target: plan.target,
    profile: plan.profile,
    plannedFiles: plannedFilesFromPlan(plan),
    actor: opts.actor ?? { type: "cli" },
    result: "partial",
  });

  // 2. + 3. Backups + writes
  const writtenAbsolute: string[] = [];
  const writtenRelative: string[] = [];
  const created: InstallManifestV1["created"] = [];
  const modifiedRecords: InstallManifestV1["modified"] = [];
  const backups: InstallManifestV1["backups"] = [];
  const backupBase = backupDirForInstall(
    ws,
    plan.packId,
    Date.now(),
    randomBytes(3).toString("hex"),
  );

  // Combined list: created + modified + (forced) conflicts.
  const toWrite = [
    ...plan.created.map((f) => ({ file: f, kind: "create" as const })),
    ...plan.modified.map((f) => ({ file: f, kind: "modify" as const })),
    ...(opts.force
      ? plan.conflicts.map((c) => ({ file: c.file, kind: "modify" as const }))
      : []),
  ];

  try {
    for (const item of toWrite) {
      const f = item.file;
      const abs = path.resolve(ws.projectRoot, f.path);
      // First containment check — catches obvious escapes early.
      await realpathContained(ws.projectRoot, abs);
      const content = normalizeForHash(
        f.content.endsWith("\n") ? f.content : `${f.content}\n`,
      );
      const sha = sha256Hex(content);
      const isCreate = item.kind === "create";
      if (item.kind === "modify") {
        const original = await fs.readFile(abs, "utf8").catch(() => undefined);
        if (original !== undefined) {
          const backupRel = path.posix.join(
            ".agentpack",
            "backups",
            sanitizePack(plan.packId),
            path.basename(backupBase),
            toRelative(ws.projectRoot, abs),
          );
          const backupAbs = path.resolve(ws.projectRoot, backupRel);
          // Second containment check before backup write — defense-in-depth.
          await realpathContained(ws.projectRoot, backupAbs);
          await fs.mkdir(path.dirname(backupAbs), { recursive: true });
          await fs.writeFile(backupAbs, original, "utf8");
          backups.push({
            original: toRelative(ws.projectRoot, abs),
            backupPath: backupRel,
            originalSha256: sha256Hex(normalizeForHash(original)),
          });
          modifiedRecords.push({ path: toRelative(ws.projectRoot, abs), sha256: sha });
        } else {
          // The "modify" classification was based on stale read; demote to create.
          created.push({ path: toRelative(ws.projectRoot, abs), sha256: sha });
        }
      } else {
        created.push({ path: toRelative(ws.projectRoot, abs), sha256: sha });
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // For create items, use O_EXCL via `wx` flag so a file planted between
      // plan and apply is surfaced as a conflict rather than silently
      // overwritten. See security-reviewer finding #8.
      await atomicWriteFile(abs, content, isCreate ? "wx" : "w");
      // Re-check containment AFTER write to defeat symlink-swap TOCTOU:
      // an attacker who swapped a parent directory for a symlink between
      // the initial check and the rename would be caught here.
      // See security-reviewer finding #1.
      await realpathContained(ws.projectRoot, abs);
      writtenAbsolute.push(abs);
      writtenRelative.push(toRelative(ws.projectRoot, abs));
    }

    // Carry ownership across a re-install: an `unchanged` file may already
    // be owned by THIS pack from a previous install. If so, the new manifest
    // must record it so uninstall still does the right thing; otherwise the
    // prior install's tracked file becomes an orphan. We only re-claim what
    // the prior manifest already claimed — user-owned files that happen to
    // be bit-identical (a separate, valid `unchanged` case) must NOT be
    // adopted. Also: if the prior manifest had this path as `modified` with
    // a backup of the user's original, preserve BOTH the modified status
    // and the backup record — otherwise uninstall would delete the file
    // instead of restoring the user's pre-install version.
    // Confirmed via live probe 2026-05-19 (iter-5 QA finding #1; codex P1).
    const prior = await readPriorManifest(ws, plan.packId);
    const priorCreatedSet = new Set(prior?.created.map((c) => c.path) ?? []);
    const priorModifiedSet = new Set(prior?.modified.map((m) => m.path) ?? []);
    for (const f of plan.unchanged) {
      const rel = f.path;
      const wasCreated = priorCreatedSet.has(rel);
      const wasModified = priorModifiedSet.has(rel);
      if (!wasCreated && !wasModified) continue;
      const abs = path.resolve(ws.projectRoot, rel);
      await realpathContained(ws.projectRoot, abs);
      const content = normalizeForHash(
        f.content.endsWith("\n") ? f.content : `${f.content}\n`,
      );
      const sha = sha256Hex(content);
      const alreadyInCreated = created.some((c) => c.path === rel);
      const alreadyInModified = modifiedRecords.some((m) => m.path === rel);
      if (alreadyInCreated || alreadyInModified) continue;
      if (wasModified) {
        modifiedRecords.push({ path: rel, sha256: sha });
        // Carry forward the prior install's backup so uninstall can restore
        // the user's pre-install content. Without this, the new manifest has
        // no backup record for this path and `--force-restore` has nothing
        // to restore from.
        const priorBackup = prior?.backups.find((b) => b.original === rel);
        if (priorBackup && !backups.some((b) => b.original === rel)) {
          backups.push(priorBackup);
        }
      } else {
        created.push({ path: rel, sha256: sha });
      }
    }

    // 4. AGENTPACK.lock
    const lockBytes = serializeLockfile(plan.lockfile);
    await atomicWriteFile(ws.lockfilePath, lockBytes);
    writtenAbsolute.push(ws.lockfilePath);
    writtenRelative.push(toRelative(ws.projectRoot, ws.lockfilePath));

    // 5. Install manifest
    const manifest: InstallManifestV1 = {
      manifestVersion: 1,
      packId: plan.packId,
      packVersion: plan.packVersion,
      target: plan.target,
      profile: plan.profile,
      installedAt: new Date().toISOString(),
      cliVersion: plan.lockfile.generator.cli,
      adapterVersions: { [plan.target]: plan.lockfile.generator.adapter },
      created,
      modified: modifiedRecords,
      backups,
      atomIds: plan.atoms,
      lockfileChecksum: lockfileChecksum(plan.lockfile),
      rollbackable: true,
    };
    const manifestPath = await writeInstallManifest(ws, manifest);

    // 6. WAL commit
    const commitEntry = await recordHistory(ws, {
      id: newHistoryId(),
      action: "install_commit",
      timestamp: new Date().toISOString(),
      packId: plan.packId,
      packVersion: plan.packVersion,
      target: plan.target,
      profile: plan.profile,
      manifestPath: toRelative(ws.projectRoot, manifestPath),
      actor: opts.actor ?? { type: "cli" },
      result: "success",
    });

    return { manifestPath, written: writtenRelative, commitEntry };
  } catch (err) {
    // Best-effort cleanup of files we just wrote; the begin entry stays for
    // the next CLI invocation's recovery sweep to consume.
    for (const w of writtenAbsolute) {
      await fs.unlink(w).catch(() => {});
    }
    // Record the failure for audit; recovery sweep still owns rollback.
    await recordHistory(ws, {
      id: newHistoryId(),
      action: "install_commit",
      timestamp: new Date().toISOString(),
      packId: plan.packId,
      packVersion: plan.packVersion,
      target: plan.target,
      profile: plan.profile,
      actor: opts.actor ?? { type: "cli" },
      result: "failed",
      error: err instanceof Error ? err.message : String(err),
      recoveredBegin: beginEntry.id,
    }).catch(() => {});
    throw err;
  }
}

function plannedFilesFromPlan(plan: InstallPlanV2): Array<{ path: string; sha256: string }> {
  const all = [
    ...plan.created,
    ...plan.modified,
    ...plan.conflicts.map((c) => c.file),
  ];
  return all.map((f) => {
    const content = normalizeForHash(
      f.content.endsWith("\n") ? f.content : `${f.content}\n`,
    );
    return { path: f.path, sha256: sha256Hex(content) };
  });
}

function sanitizePack(packId: string): string {
  return packId.replace(/[/\\]/g, "_");
}

async function atomicWriteFile(
  target: string,
  content: string,
  flag: "w" | "wx" = "w",
): Promise<void> {
  // For `wx` (create-only), write directly to the target with O_EXCL so a
  // file planted by a racing process surfaces as EEXIST rather than being
  // silently overwritten. Otherwise use the tmp + rename pattern for
  // crash-safe replacement of existing files.
  if (flag === "wx") {
    await fs.writeFile(target, content, { encoding: "utf8", flag: "wx" });
    return;
  }
  const tmp = `${target}.tmp-${randomBytes(3).toString("hex")}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, target);
}

/**
 * Read the prior install manifest for `packId` if one exists. Used to preserve
 * cross-install ownership of `plan.unchanged` files (re-install case) without
 * incorrectly claiming user-owned files that happen to be bit-identical, and
 * to carry forward backups for paths previously installed as `modified`.
 * Returns null on first install (no prior manifest).
 */
async function readPriorManifest(
  ws: AgentpackPaths,
  packId: string,
): Promise<import("./types.js").InstallManifestV1 | null> {
  try {
    return await readInstallManifest(ws, packId);
  } catch (err) {
    if (err instanceof InstallManifestNotFoundError) return null;
    throw err;
  }
}

// Re-exported for tests + cli convenience.
export { resolveAgentpackPaths };
export type { AgentpackPaths };
