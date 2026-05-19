import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * `.agentpack/` directory layout under the user's project root. All paths
 * returned here are absolute (resolved); the lockfile, install manifest, and
 * history entries store *project-relative* equivalents.
 */
export interface AgentpackPaths {
  /** Resolved absolute project root. */
  projectRoot: string;
  /** `<projectRoot>/.agentpack/` */
  agentpackDir: string;
  /** `<projectRoot>/.agentpack/installed/` */
  installedDir: string;
  /** `<projectRoot>/.agentpack/backups/` */
  backupsDir: string;
  /** `<projectRoot>/.agentpack/history.jsonl` */
  historyFile: string;
  /** `<projectRoot>/.agentpack/.lock` — used by proper-lockfile for serializing append. */
  historyLockFile: string;
  /** `<projectRoot>/AGENTPACK.lock` */
  lockfilePath: string;
}

export const AGENTPACK_DIR_NAME = ".agentpack";
export const LOCKFILE_NAME = "AGENTPACK.lock";
export const HISTORY_FILE_NAME = "history.jsonl";
export const INSTALLED_DIR_NAME = "installed";
export const BACKUPS_DIR_NAME = "backups";

/**
 * Resolve absolute paths for the `.agentpack/` workspace under `projectRoot`.
 * Validates that `projectRoot` exists and is a directory.
 */
export async function resolveAgentpackPaths(
  projectRoot: string,
): Promise<AgentpackPaths> {
  const abs = path.resolve(projectRoot);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(
      `projectRoot does not exist: ${abs}. Pass --project to specify an existing directory.`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`projectRoot is not a directory: ${abs}`);
  }
  const realRoot = await fs.realpath(abs);
  const agentpackDir = path.join(realRoot, AGENTPACK_DIR_NAME);
  return {
    projectRoot: realRoot,
    agentpackDir,
    installedDir: path.join(agentpackDir, INSTALLED_DIR_NAME),
    backupsDir: path.join(agentpackDir, BACKUPS_DIR_NAME),
    historyFile: path.join(agentpackDir, HISTORY_FILE_NAME),
    historyLockFile: path.join(agentpackDir, ".lock"),
    lockfilePath: path.join(realRoot, LOCKFILE_NAME),
  };
}

export async function ensureAgentpackDirs(p: AgentpackPaths): Promise<void> {
  await fs.mkdir(p.installedDir, { recursive: true });
  await fs.mkdir(p.backupsDir, { recursive: true });
}

/**
 * Compute `path.relative(root, target)`. Returns POSIX-normalized
 * project-relative path (forward slashes) so values stored in committed files
 * are portable across machines.
 */
export function toRelative(root: string, target: string): string {
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Path escapes project root: ${target} (relative to ${root} -> ${rel})`,
    );
  }
  return rel.split(path.sep).join("/");
}

/**
 * Inverse of `toRelative` — resolve a stored project-relative path to an
 * absolute path under `projectRoot`. Refuses to escape.
 */
export function fromRelative(projectRoot: string, rel: string): string {
  if (path.isAbsolute(rel)) {
    throw new Error(`Stored path must be project-relative, got absolute: ${rel}`);
  }
  // Reject Windows drive letters and UNC paths even on POSIX. A manifest
  // authored on Windows could smuggle `C:/Windows/...` strings that
  // `path.isAbsolute` returns false for on Linux but are clearly absolute
  // by intent. See security-reviewer audit finding #2.
  if (/^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\\\")) {
    throw new Error(`Stored path looks like an absolute Windows path: ${rel}`);
  }
  // Reject obvious traversal before resolution to surface a clearer error than
  // the realpath check below.
  if (rel.split(/[\\/]/).some((seg) => seg === "..")) {
    throw new Error(`Stored path contains \`..\`: ${rel}`);
  }
  const abs = path.resolve(projectRoot, rel);
  const rel2 = path.relative(projectRoot, abs);
  if (rel2.startsWith("..") || path.isAbsolute(rel2)) {
    throw new Error(`Stored path resolves outside project root: ${rel} -> ${abs}`);
  }
  return abs;
}

/**
 * Realpath containment: the canonical (symlink-resolved) absolute form of
 * `target` must be inside the canonical project root. This is the install-side
 * defense against `.claude/` being a symlink to `/etc/`.
 *
 * Returns the canonical absolute path on success; throws on escape.
 */
export async function realpathContained(
  projectRoot: string,
  target: string,
): Promise<string> {
  const real = await canonicalize(target);
  const realRoot = await fs.realpath(projectRoot);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Refusing to write outside project root: ${target} (realpath ${real} not under ${realRoot})`,
    );
  }
  return real;
}

/**
 * Best-effort realpath. For paths that don't yet exist on disk (we're about
 * to create them), realpath() throws — fall back to realpath of the deepest
 * existing parent + remaining suffix, which still detects escape via symlinks
 * earlier in the chain.
 */
async function canonicalize(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    // Walk up until we find an existing ancestor.
    let cur = p;
    const segments: string[] = [];
    while (true) {
      const parent = path.dirname(cur);
      if (parent === cur) break; // hit filesystem root
      try {
        const realParent = await fs.realpath(parent);
        return path.join(realParent, ...segments.reverse(), path.basename(p));
      } catch {
        segments.push(path.basename(cur));
        cur = parent;
      }
    }
    return path.resolve(p);
  }
}

export function installManifestPath(p: AgentpackPaths, packId: string): string {
  return path.join(p.installedDir, `${sanitizePackIdForFile(packId)}.json`);
}

export function backupDirForInstall(
  p: AgentpackPaths,
  packId: string,
  timestampMs: number,
  nonceHex6: string,
): string {
  const dir = `${timestampMs}.${nonceHex6}`;
  return path.join(p.backupsDir, sanitizePackIdForFile(packId), dir);
}

/**
 * Pack IDs are dotted (e.g. `agentpack.pr-quality`). Filesystem-safe form
 * replaces `/` (none expected, but defensive) with `_`. The dotted form is
 * preserved because users will grep `.agentpack/installed/` for pack names.
 */
export function sanitizePackIdForFile(packId: string): string {
  return packId.replace(/[/\\]/g, "_");
}
