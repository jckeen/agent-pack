import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

/**
 * Reconcile an atom body's heading hierarchy with the section header the
 * adapter emits for that atom (issue #24).
 *
 * Instruction/rule/workflow atoms are rendered under a section header
 * (`## <Atom>` or `### <Atom>`) and then the atom body is appended verbatim.
 * When the body itself opens with a top-level `# Title`, two things break:
 *  1. The title appears twice (once as the section header, once as the body H1).
 *  2. An `<h1>` lands beneath an `<h2>`/`<h3>`, producing a broken heading
 *     hierarchy in the generated CLAUDE.md / AGENTS.md.
 *
 * We only act when the body's FIRST non-empty line is a top-level `# ` heading.
 * Two cases, depending on whether that H1's text matches `atomName` (the text
 * already shown in the section header), compared trimmed and case-insensitively:
 *  - MATCH → strip the redundant leading H1 line (and a single blank line after
 *    it) so the title is not duplicated, then demote any REMAINING headings so
 *    the highest remaining one sits at `sectionLevel + 1`.
 *  - DIFFER → keep the leading H1 and demote every heading so the leading `#`
 *    becomes `sectionLevel + 1`, preserving relative depth.
 *
 * Bodies that already nest correctly (first non-empty line is not a `# `
 * heading) are returned unchanged — a no-op for well-formed bodies, so output
 * stays deterministic.
 *
 * Headings inside fenced code blocks (``` / ~~~) are left untouched — a `#` at
 * the start of a line in a shell snippet is a comment, not a heading. CRLF
 * line endings are tolerated: a body authored on Windows (`# Title\r`) is
 * demoted/stripped just like an LF body.
 *
 * @param sectionLevel the heading level of the section header the adapter
 *   already emitted for this atom (2 for `##`, 3 for `###`).
 * @param atomName the atom name rendered in the section header, used to detect
 *   a redundant duplicate leading H1.
 */
export function demoteBodyHeadings(
  body: string,
  sectionLevel: number,
  atomName: string,
): string {
  // Split on \n; carry any trailing \r per line so CRLF bodies round-trip.
  const lines = body.split("\n");

  // Find the first non-empty line; only act when it is a top-level `# ` ATX
  // heading. This keeps the transform targeted at the duplicate-title shape.
  // `\s` covers a lone trailing `\r` on a CRLF line.
  let firstContentIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "") {
      firstContentIdx = i;
      break;
    }
  }
  if (firstContentIdx === -1) return body;
  const leadingH1 = /^# (?!#)(.*?)\r?$/.exec(lines[firstContentIdx]!);
  if (!leadingH1) return body;

  // Markdown caps at h6; never exceed it so deeply nested bodies stay valid.
  const maxLevel = 6;

  const namesMatch = leadingH1[1]!.trim().toLowerCase() === atomName.trim().toLowerCase();

  let workingLines = lines;
  if (namesMatch) {
    // Strip the redundant leading H1 line. Also drop a single immediately
    // following blank line so we don't leave a double blank between the
    // section header and the body.
    const after = lines.slice(firstContentIdx + 1);
    if (after.length > 0 && after[0]!.trim() === "") after.shift();
    workingLines = [...lines.slice(0, firstContentIdx), ...after];
  }

  // After a strip, the highest remaining heading should land at
  // `sectionLevel + 1`. Find the minimum heading level among the remaining
  // (non-fenced) headings to compute the shift; if none remain, nothing to do.
  const minRemaining = minHeadingLevel(workingLines);
  if (minRemaining === Infinity) return workingLines.join("\n");

  // For the differ case minRemaining is 1 (the kept leading H1), so the shift
  // is `sectionLevel` and the leading `#` becomes `sectionLevel + 1`. For the
  // strip case the shift lifts whatever the highest remaining heading is to
  // `sectionLevel + 1` so subsections stay valid.
  const shift = sectionLevel + 1 - minRemaining;
  if (shift === 0) return workingLines.join("\n");

  let inFence = false;
  let fenceMarker = "";
  const out = workingLines.map((line) => {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!.startsWith("`") ? "```" : "~~~";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      return line;
    }
    if (inFence) return line;
    const headingMatch = /^(#{1,6}) (.*?)(\r?)$/.exec(line);
    if (!headingMatch) return line;
    const level = headingMatch[1]!.length;
    const newLevel = Math.min(Math.max(level + shift, 1), maxLevel);
    return `${"#".repeat(newLevel)} ${headingMatch[2]}${headingMatch[3]}`;
  });
  return out.join("\n");
}

/** Lowest ATX heading level (1 = `#`) among non-fenced lines, or Infinity. */
function minHeadingLevel(lines: string[]): number {
  let inFence = false;
  let fenceMarker = "";
  let min = Infinity;
  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!.startsWith("`") ? "```" : "~~~";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;
    const headingMatch = /^(#{1,6}) /.exec(line);
    if (headingMatch) min = Math.min(min, headingMatch[1]!.length);
  }
  return min;
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

export interface ResolvedSubagent {
  /** The subagent's system-prompt instructions. */
  instructions: string;
  /** A `description` lifted from a markdown agent's frontmatter, if present. */
  description?: string;
  /** `tools` from a markdown agent's frontmatter (Claude Code agent loader key). */
  tools?: string;
  /** `model` from a markdown agent's frontmatter (Claude Code agent loader key). */
  model?: string;
}

/**
 * Resolve a subagent atom's body into its system-prompt instructions, handling
 * both storage forms:
 *
 *  - **Markdown** (`*.md`) — Claude Code's native agent format: optional `---`
 *    frontmatter (name/description/tools) followed by the prompt body. The body
 *    becomes the instructions; a frontmatter `description` is surfaced too. This
 *    is what lets a manifest reference an existing `.claude/agents/*.md` IN PLACE
 *    without a descriptor wrapper.
 *  - **YAML descriptor** (anything else, e.g. importer-emitted `*.yaml`) — a
 *    mapping with an `instructions` string. Back-compatible with existing packs.
 *
 * Falls back to `atom.description` when the body is missing/empty or a descriptor
 * carries no `instructions` — never silently emits a half-empty agent.
 */
export async function resolveSubagentBody(
  packRoot: string,
  atom: Atom,
): Promise<ResolvedSubagent> {
  const raw = await readAtomFile(packRoot, atom);
  if (raw == null || raw.trim() === "") return { instructions: atom.description };

  if (/\.(md|markdown)$/i.test(atom.path)) {
    let body = raw;
    let description: string | undefined;
    let tools: string | undefined;
    let model: string | undefined;
    if (raw.startsWith("---")) {
      const end = raw.indexOf("\n---", 3);
      if (end !== -1) {
        const fmText = raw.slice(3, end).replace(/^\r?\n/, "");
        body = raw.slice(end + 4).replace(/^\r?\n/, "");
        try {
          const fm = parseYaml(fmText) as Record<string, unknown> | null;
          const fmStr = (k: string): string | undefined =>
            fm && typeof fm[k] === "string"
              ? (fm[k] as string).trim() || undefined
              : undefined;
          description = fmStr("description");
          tools = fmStr("tools");
          model = fmStr("model");
        } catch {
          /* malformed frontmatter — fall through with the raw body */
        }
      }
    }
    return { instructions: body.trim() || atom.description, description, tools, model };
  }

  // YAML-descriptor form: a mapping with an `instructions` string.
  try {
    const parsed = parseYaml(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const ins = (parsed as Record<string, unknown>)["instructions"];
      if (typeof ins === "string" && ins.trim()) return { instructions: ins.trim() };
    }
  } catch {
    /* not a YAML descriptor */
  }
  return { instructions: atom.description };
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

/**
 * Read a pack-relative file referenced by manifest/atom content (e.g. a
 * `prompt:` path or a skill companion file) — the trust boundary for files
 * NOT named by `atom.path`. Single owner of these rules so every adapter
 * (claudeCode, codex, exportChat, …) shares one symlink-safe gate.
 *
 * A pack author controls these paths, so a symlink at `relPath` pointing at
 * `/etc/passwd` (or any file outside the pack) must NOT be followed and read
 * into the exported/uploaded artifact. Rules, all failing CLOSED to `null`
 * (skip the content — never hard-fail an export on a hostile pack):
 *  - reject absolute / `~` / `..` (lexical).
 *  - reject if the resolved path escapes packRoot (lexical).
 *  - reject a symlink AT relPath, and reject if realpath escapes packRoot.
 *  - only read a regular file; missing/other IO → null.
 */
export async function readPackRelativeFile(
  packRoot: string,
  relPath: string,
): Promise<string | null> {
  if (
    path.isAbsolute(relPath) ||
    relPath.startsWith("~") ||
    relPath.split(/[\\/]+/).includes("..")
  ) {
    return null;
  }
  const target = path.resolve(packRoot, relPath);
  if (
    (() => {
      const rel = path.relative(packRoot, target);
      return rel.startsWith("..") || path.isAbsolute(rel);
    })()
  ) {
    return null;
  }
  let lstat;
  try {
    lstat = await fs.lstat(target);
  } catch {
    return null; // missing / unreadable → skip
  }
  // Reject a symlink at the target outright — a pack must not redirect a
  // prompt/companion read to an arbitrary file via a symlink (CWE-59).
  if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
  // Defense-in-depth: confirm symlinked ancestors don't redirect outside.
  try {
    const realPack = await fs.realpath(packRoot);
    const realTarget = await fs.realpath(target);
    const realRel = path.relative(realPack, realTarget);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
  } catch {
    return null;
  }
  try {
    return await fs.readFile(target, "utf8");
  } catch {
    return null;
  }
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
