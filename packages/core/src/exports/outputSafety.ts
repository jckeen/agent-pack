// Shared write-side containment for everything that materializes files into a
// caller-chosen output directory (exporters, `writeImport`). A lexical
// `path.relative` check alone is not containment: a symlink already sitting in
// the output directory redirects the write wherever it points. Every write
// here is checked against the REAL directory it lands in.

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** True when `child` is strictly inside `parent` (lexical). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Create `outDir` if needed and return both its resolved path (what callers
 * report back) and its real path (what every write is contained against).
 */
export async function prepareOutDir(
  outDir: string,
): Promise<{ outDir: string; realOut: string }> {
  const resolved = path.resolve(outDir);
  await fs.mkdir(resolved, { recursive: true });
  return { outDir: resolved, realOut: await fs.realpath(resolved) };
}

/**
 * Refuse a planned file set in which one path is also a directory prefix of
 * another (`a` and `a/b`). Checked before the first write so the conflict
 * cannot leave a half-written output directory behind.
 */
export function assertNoPathConflicts(relPaths: readonly string[]): void {
  const normalized = relPaths.map((p) =>
    p
      .split(/[\\/]+/)
      .filter(Boolean)
      .join("/"),
  );
  const files = new Set(normalized);
  for (const p of normalized) {
    const segments = p.split("/");
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join("/");
      if (files.has(ancestor)) {
        throw new Error(
          `Refusing to export: \`${ancestor}\` is planned as a file but \`${p}\` needs it to be a directory.`,
        );
      }
    }
  }
}

/**
 * Remove the paths an exporter owns before it writes, so re-exporting a
 * narrower profile into a reused directory cannot retain the wider profile's
 * hooks/commands (a later import of the "safe" output would resurrect them).
 * A symlink at a managed path is refused outright rather than removed or
 * followed: it would redirect the write outside outDir.
 */
export async function removeManagedPaths(
  realOut: string,
  managedPaths: readonly string[],
): Promise<void> {
  for (const rel of managedPaths) {
    const abs = path.join(realOut, rel);
    const lstat = await fs.lstat(abs).catch(() => null);
    if (!lstat) continue;
    if (lstat.isSymbolicLink()) {
      throw new Error(
        `Refusing to export: \`${rel}\` in the output directory is a symlink — writes through it could land outside outDir. Remove it and re-run.`,
      );
    }
    await fs.rm(abs, { recursive: true, force: true });
  }
}

/**
 * Write one file under `realOut` (which must already be a real path). Returns
 * the path relative to `realOut`.
 */
export async function writeContainedFile(
  realOut: string,
  relPath: string,
  content: string | Uint8Array,
): Promise<string> {
  const absPath = path.resolve(realOut, relPath);
  if (!isInside(realOut, absPath)) {
    throw new Error(`Refusing to write outside outDir: ${relPath}`);
  }
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  // Containment is re-checked on the REAL directory path so a symlinked
  // intermediate directory can't redirect the write (lexical alone is not
  // enough), and an existing symlink at the file path itself is refused.
  const realDir = await fs.realpath(path.dirname(absPath));
  if (!isInside(realOut, path.join(realDir, path.basename(absPath)))) {
    throw new Error(`Refusing to write through a symlink outside outDir: ${relPath}`);
  }
  const existing = await fs.lstat(absPath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to write through a symlink at ${relPath}`);
  }
  // O_NOFOLLOW closes the window between the lstat check and the write —
  // a symlink appearing in between fails the open instead of redirecting it.
  const handle = await fs.open(
    absPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return path.relative(realOut, absPath);
}
