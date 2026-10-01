// Read-side containment shared by the directory importers. Extracted from the
// Agent Plugins importer (#215) so every sibling that walks an import source
// applies the same rules (#216): a symlink is followed only when its REAL
// target stays inside an allowed root, directory aliases and cycles are walked
// once, binary files are skipped rather than corrupted through UTF-8
// decoding, and a per-file plus an aggregate byte budget bound what the
// importer will hold in memory.

import { isUtf8 } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MAX_IMPORT_FILES = 5000;
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_TOTAL_BYTES = 50 * 1024 * 1024;

const SUBTREE_IGNORE = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  "__pycache__",
  ".venv",
]);

export type ContainedReaderWarn = (source: string, message: string) => void;

export interface ContainedReaderOptions {
  /** Subject of the budget errors, e.g. `Agent Plugins source`. */
  sourceLabel: string;
  /** What the containment root is called in warnings, e.g. `plugin root`. */
  rootLabel: string;
  /** Appended to the symlink-escape warning (leading space included). */
  escapeNote?: string;
  /** Appended to the non-UTF-8 warning (leading space included). */
  binaryNote?: string;
  /**
   * Additional REAL directories a symlink may resolve into. Empty for
   * third-party input; an importer reading the operator's own config passes
   * the trees that config legitimately links to.
   */
  extraRoots?: readonly string[];
}

/** True when `abs` is `root` or lexically inside it. */
export function isInsideRoot(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Tracks the aggregate byte budget for importers that keep their own walk
 * (they skip symlinks entirely, so only the memory bound is shared).
 */
export class ImportByteBudget {
  private totalBytes = 0;

  constructor(private readonly sourceLabel: string) {}

  /** Account for `bytes`; throws once the aggregate budget is exceeded. */
  add(bytes: number): void {
    this.totalBytes += bytes;
    if (this.totalBytes > MAX_IMPORT_TOTAL_BYTES) {
      throw new Error(
        `${this.sourceLabel} exceeds the ${MAX_IMPORT_TOTAL_BYTES}-byte total budget; refusing to import.`,
      );
    }
  }
}

/** Reader with the containment/budget/binary rules applied uniformly. */
export class ContainedReader {
  private count = 0;
  private totalBytes = 0;
  /** Real paths of directories already walked — breaks symlink cycles. */
  private readonly visitedDirs = new Set<string>();
  private readonly allowedRoots: string[];

  constructor(
    realRoot: string,
    private readonly warn: ContainedReaderWarn,
    private readonly options: ContainedReaderOptions,
  ) {
    this.allowedRoots = [realRoot, ...(options.extraRoots ?? [])];
  }

  private isAllowed(real: string): boolean {
    return this.allowedRoots.some((root) => isInsideRoot(root, real));
  }

  private warnEscape(rel: string): void {
    this.warn(
      rel,
      `\`${rel}\` is a symlink escaping the ${this.options.rootLabel} — not read${this.options.escapeNote ?? ""}.`,
    );
  }

  /**
   * Resolve a directory that may be a symlink: returns its real path when it
   * is a directory whose real target stays inside an allowed root; null (with
   * a warning for escapes) otherwise.
   */
  async containedDir(abs: string, rel: string): Promise<string | null> {
    const lstat = await fs.lstat(abs).catch(() => null);
    if (!lstat) return null;
    if (!lstat.isSymbolicLink() && !lstat.isDirectory()) return null;
    const real = await fs.realpath(abs).catch(() => null);
    if (real === null) return null;
    if (!this.isAllowed(real)) {
      this.warnEscape(rel);
      return null;
    }
    const stat = await fs.stat(real).catch(() => null);
    return stat?.isDirectory() ? real : null;
  }

  /**
   * Read one file if it passes every gate; null otherwise. Symlinks are
   * followed but the REAL target must stay inside an allowed root. The real
   * path is checked for every file, not only when the last path component is
   * a symlink, so a symlinked directory earlier in `abs` cannot slip through.
   */
  async read(abs: string, rel: string): Promise<string | null> {
    const lstat = await fs.lstat(abs).catch(() => null);
    if (!lstat) return null;
    const real = await fs.realpath(abs).catch(() => null);
    if (real === null || !this.isAllowed(real)) {
      this.warnEscape(rel);
      return null;
    }
    const target = real;
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) return null;
    if (stat.size > MAX_IMPORT_FILE_BYTES) {
      this.warn(
        rel,
        `\`${rel}\` exceeds the ${MAX_IMPORT_FILE_BYTES}-byte per-file limit — skipped.`,
      );
      return null;
    }
    if (this.count + 1 > MAX_IMPORT_FILES) {
      throw new Error(
        `${this.options.sourceLabel} has more than ${MAX_IMPORT_FILES} files; refusing to import.`,
      );
    }
    if (this.totalBytes + stat.size > MAX_IMPORT_TOTAL_BYTES) {
      throw new Error(
        `${this.options.sourceLabel} exceeds the ${MAX_IMPORT_TOTAL_BYTES}-byte total budget; refusing to import.`,
      );
    }
    const buf = await fs.readFile(target);
    // Re-check the budget against the bytes actually read — the pre-read
    // stat.size is advisory (the file may have grown in between).
    if (
      buf.length > MAX_IMPORT_FILE_BYTES ||
      this.totalBytes + buf.length > MAX_IMPORT_TOTAL_BYTES
    ) {
      throw new Error(
        `${this.options.sourceLabel} exceeds the ${MAX_IMPORT_TOTAL_BYTES}-byte total budget; refusing to import.`,
      );
    }
    // NUL check catches most binaries cheaply; isUtf8 catches the rest
    // (e.g. Latin-1) that UTF-8 decoding would corrupt via replacement chars.
    if (buf.includes(0) || !isUtf8(buf)) {
      this.warn(
        rel,
        `\`${rel}\` is not UTF-8 text — skipped rather than corrupted${this.options.binaryNote ?? ""}.`,
      );
      return null;
    }
    this.count += 1;
    this.totalBytes += buf.length;
    return buf.toString("utf8");
  }

  async walkInto(tree: Map<string, string>, absDir: string, relDir: string): Promise<void> {
    // `absDir` is already a real, contained path (callers resolve through
    // containedDir / the recursion below). The visited set breaks cycles
    // introduced by internal directory symlinks pointing at an ancestor, and
    // bounds the walk when several aliases point at the same directory.
    if (this.visitedDirs.has(absDir)) return;
    this.visitedDirs.add(absDir);
    const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SUBTREE_IGNORE.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      const rel = `${relDir}/${entry.name}`;
      const lstat = await fs.lstat(abs).catch(() => null);
      if (!lstat) continue;
      if (lstat.isSymbolicLink()) {
        const real = await fs.realpath(abs).catch(() => null);
        if (real === null || !this.isAllowed(real)) {
          this.warnEscape(rel);
          continue;
        }
        const realStat = await fs.stat(real).catch(() => null);
        if (realStat?.isDirectory()) {
          await this.walkInto(tree, real, rel);
          continue;
        }
        // A symlink to a contained file falls through to read() below.
      } else if (lstat.isDirectory()) {
        // Normalize to the real path so the visited set is canonical even
        // when an ancestor was reached through an internal symlink.
        const real = await fs.realpath(abs).catch(() => null);
        if (real !== null) await this.walkInto(tree, real, rel);
        continue;
      }
      const content = await this.read(abs, rel);
      if (content !== null) tree.set(rel, content);
    }
  }
}
