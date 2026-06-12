import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type {
  AdapterExportOptions,
  AdapterOutputFile,
  AdapterResult,
  AgentPackAdapter,
  Atom,
  ResolvedAtom,
  TargetPlatform,
} from "../schema/types.js";

export type { AgentPackAdapter, AdapterExportOptions, AdapterResult };

/**
 * Defang AgentPack marker tokens that appear in pack-controlled body text.
 *
 * The span matcher (`install/merge.ts`) keys on the literal `BEGIN AGENTPACK:`
 * / `END AGENTPACK:`. Without this, a malicious atom body could embed its own
 * early `END AGENTPACK: <self>` (so surgical uninstall strips only part of the
 * block, leaving attacker content behind) or a forged `BEGIN/END AGENTPACK:
 * <other-pack>` span (spoofing that a never-installed pack is present). We
 * break the inner space with a hyphen — the matcher no longer recognizes it
 * while the text stays readable in CLAUDE.md/AGENTS.md.
 */
function neutralizeMarkers(body: string): string {
  return body
    .replace(/BEGIN AGENTPACK:/g, "BEGIN-AGENTPACK:")
    .replace(/END AGENTPACK:/g, "END-AGENTPACK:");
}

/**
 * Wrap content in the AgentPack BEGIN/END markers used by all instruction
 * outputs (CLAUDE.md, AGENTS.md, etc.). The packId is rendered in both
 * markers so multiple AgentPacks can coexist in one file.
 */
export function wrapInstructionBlock(packId: string, body: string): string {
  return `<!-- BEGIN AGENTPACK: ${packId} -->\n${neutralizeMarkers(body.trimEnd())}\n<!-- END AGENTPACK: ${packId} -->\n`;
}

/**
 * Render a `---`-delimited YAML frontmatter block for emitted .md files
 * (commands, subagents). Values are serialized through the YAML library —
 * never string-interpolated — so an atom description containing `: `,
 * quotes, or flow characters cannot break the frontmatter of the file it
 * lands in. `undefined` values are omitted.
 */
export function yamlFrontmatter(fields: Record<string, unknown>): string {
  const present: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) present[k] = v;
  }
  return `---\n${stringifyYaml(present, { lineWidth: 0 })}---\n`;
}

export class AtomPathEscapeError extends Error {
  constructor(
    public readonly atomId: string,
    public readonly atomPath: string,
  ) {
    super(
      `Atom \`${atomId}\` path \`${atomPath}\` escapes the pack root. Atom paths must be relative paths inside the pack directory and must not be symlinks pointing outside the pack.`,
    );
    this.name = "AtomPathEscapeError";
  }
}

export class AtomReadError extends Error {
  public readonly atomId: string;
  public readonly atomPath: string;
  public override readonly cause: NodeJS.ErrnoException;
  constructor(atomId: string, atomPath: string, cause: NodeJS.ErrnoException) {
    super(
      `Failed to read atom \`${atomId}\` at \`${atomPath}\` (${cause.code ?? "ERR"}: ${cause.message})`,
    );
    this.name = "AtomReadError";
    this.atomId = atomId;
    this.atomPath = atomPath;
    this.cause = cause;
  }
}

/**
 * Resolve `atom.path` against `packRoot` and assert the result stays inside
 * the pack directory after symlink resolution. Throws `AtomPathEscapeError`
 * on traversal attempts.
 *
 * Rules enforced:
 *  - `atom.path` must not be absolute.
 *  - `atom.path` must not contain `..` traversal that escapes the pack root.
 *  - The on-disk realpath of `atom.path` must remain inside `packRoot`'s realpath.
 *  - Direct symlinks AT `atom.path` that point outside the pack root are rejected.
 */
async function resolveInsidePack(
  packRoot: string,
  atom: Atom,
): Promise<{ target: string; lstat: Awaited<ReturnType<typeof fs.lstat>> | null }> {
  const rel = atom.path;
  if (path.isAbsolute(rel)) throw new AtomPathEscapeError(atom.id, rel);
  // Reject `..` segments early — even if the resolved path would stay inside,
  // forbidding `..` keeps the trust boundary obvious and prevents
  // packRoot-symlinks from being weaponized.
  const segments = rel.split(/[\\/]+/);
  if (segments.includes("..")) throw new AtomPathEscapeError(atom.id, rel);

  const joined = path.resolve(packRoot, rel);
  // Containment by path.relative — pre-symlink-resolution.
  const lexicalRel = path.relative(packRoot, joined);
  if (lexicalRel.startsWith("..") || path.isAbsolute(lexicalRel)) {
    throw new AtomPathEscapeError(atom.id, rel);
  }

  // realpath: confirm symlinks don't redirect outside.
  let lstat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    lstat = await fs.lstat(joined);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      // Missing — let caller surface as a warning / hard error per policy.
      return { target: joined, lstat: null };
    }
    throw new AtomReadError(atom.id, rel, e);
  }

  // If the atom path or any prefix is a symlink, realpath it and check.
  let realPack: string;
  let realTarget: string;
  try {
    realPack = await fs.realpath(packRoot);
    realTarget = await fs.realpath(joined);
  } catch (err) {
    throw new AtomReadError(atom.id, rel, err as NodeJS.ErrnoException);
  }
  const realRel = path.relative(realPack, realTarget);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new AtomPathEscapeError(atom.id, rel);
  }
  return { target: joined, lstat };
}

/**
 * Read the contents of an atom's `path` field. Path is resolved against the
 * pack root and rejected if it escapes via `..`, absolute paths, or symlinks.
 *
 * Returns the file contents on success, or `null` only when the path is
 * cleanly missing (ENOENT). Any other read error throws — silent fallback
 * to `null` for permission/IO errors would let exports look complete while
 * shipping degenerate output.
 */
export async function readAtomFile(packRoot: string, atom: Atom): Promise<string | null> {
  const { target, lstat } = await resolveInsidePack(packRoot, atom);
  if (lstat === null) return null;
  // Refuse symlinks at the atom path itself. resolveInsidePack already
  // verified realpath stays inside the pack, but if the user's pack root is
  // ITSELF a symlink, realpath collapses both sides. Tightening: refuse
  // symlinks at the atom path outright. Packs that need to share content
  // should use real files or copy in build.
  if (lstat.isSymbolicLink()) {
    throw new AtomPathEscapeError(atom.id, atom.path);
  }
  if (!lstat.isFile()) return null;
  try {
    return await fs.readFile(target, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw new AtomReadError(atom.id, atom.path, e);
  }
}

/**
 * Recursively read a skill folder into a list of {relPath, content} entries.
 *
 * Behavior:
 *  - Refuses paths that escape the pack root (same rules as readAtomFile).
 *  - Refuses symlinks at any depth (skipped silently inside the walk, since
 *    a malicious symlink would not produce a useful skill anyway and we don't
 *    want one accidental symlink to fail the whole export).
 *  - Returns `[]` only when the path is missing (ENOENT). Other errors throw.
 */
export async function readAtomDirectory(
  packRoot: string,
  atom: Atom,
): Promise<Array<{ relPath: string; content: string }>> {
  const { target: root, lstat } = await resolveInsidePack(packRoot, atom);
  if (lstat === null) return [];
  if (lstat.isSymbolicLink()) {
    throw new AtomPathEscapeError(atom.id, atom.path);
  }
  if (!lstat.isDirectory()) {
    if (lstat.isFile()) {
      try {
        const content = await fs.readFile(root, "utf8");
        return [{ relPath: path.basename(root), content }];
      } catch (err) {
        throw new AtomReadError(atom.id, atom.path, err as NodeJS.ErrnoException);
      }
    }
    return [];
  }
  const realPack = await fs.realpath(packRoot);
  const results: Array<{ relPath: string; content: string }> = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: Array<{
      name: string;
      isDir: boolean;
      isFile: boolean;
      isSymlink: boolean;
    }>;
    try {
      const raw = await fs.readdir(dir, { withFileTypes: true });
      raw.sort((a, b) => a.name.localeCompare(b.name));
      entries = raw.map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
        isFile: e.isFile(),
        isSymlink: e.isSymbolicLink(),
      }));
    } catch (err) {
      throw new AtomReadError(atom.id, atom.path, err as NodeJS.ErrnoException);
    }
    for (const entry of entries) {
      if (entry.isSymlink) continue; // refuse symlinks
      const abs = path.join(dir, entry.name);
      // Re-assert containment relative to packRoot's realpath to catch any
      // race where a directory was replaced with a symlink mid-walk.
      const realAbs = await fs.realpath(abs).catch(() => abs);
      const containment = path.relative(realPack, realAbs);
      if (containment.startsWith("..") || path.isAbsolute(containment)) {
        throw new AtomPathEscapeError(atom.id, atom.path);
      }
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDir) {
        await walk(abs, next);
      } else if (entry.isFile) {
        try {
          const content = await fs.readFile(abs, "utf8");
          results.push({ relPath: next, content });
        } catch (err) {
          throw new AtomReadError(atom.id, atom.path, err as NodeJS.ErrnoException);
        }
      }
    }
  }
  await walk(root, "");
  return results;
}

export function atomsByType(resolved: ResolvedAtom[]): Map<string, Atom[]> {
  const byType = new Map<string, Atom[]>();
  for (const r of resolved) {
    const list = byType.get(r.atom.type) ?? [];
    list.push(r.atom);
    byType.set(r.atom.type, list);
  }
  return byType;
}

export interface AdapterBaseInit {
  target: TargetPlatform;
  build(options: AdapterExportOptions): Promise<{
    files: AdapterOutputFile[];
    warnings: string[];
    unsupportedAtoms: string[];
  }>;
}

export function defineAdapter(init: AdapterBaseInit): AgentPackAdapter {
  return {
    target: init.target,
    async export(options) {
      const result = await init.build(options);
      // Sort files by path for deterministic output.
      const files = result.files.slice().sort((a, b) => a.path.localeCompare(b.path));
      // Backstop: two atoms emitting the same output path would make the
      // installer attempt a duplicate create and roll the install back.
      // Keep the first, drop the rest, and say so.
      const warnings = [...result.warnings];
      const seen = new Set<string>();
      const deduped = files.filter((f) => {
        if (seen.has(f.path)) {
          warnings.push(
            `Adapter emitted \`${f.path}\` more than once; keeping the first occurrence. This usually means two atoms share a slug.`,
          );
          return false;
        }
        seen.add(f.path);
        return true;
      });
      return {
        target: init.target,
        files: deduped,
        warnings,
        unsupportedAtoms: result.unsupportedAtoms,
      };
    },
  };
}

export function stableJsonStringify(value: unknown): string {
  // Sort object keys recursively for deterministic JSON. Drop own
  // `__proto__` and `constructor` keys to avoid pollution risks downstream.
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of entries) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}
