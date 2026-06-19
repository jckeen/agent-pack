// `agentpack import --from claude-code` — I/O entry. Walks a Claude Code config
// directory (`~/.claude` or a project root with `.claude/` + CLAUDE.md) into a
// path→content map, then defers to the pure parse + build pipeline.
//
// Secret hygiene: `.credentials.json` and machine-specific runtime dirs are
// never read (see IGNORE). MCP `env` surfaces KEY NAMES only — never values.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stringify } from "yaml";
import { parseClaudeCode } from "./parseClaudeCode.js";
import {
  buildClaudeCodeManifest,
  type BuildClaudeCodeManifestOptions,
} from "./buildClaudeCodeManifest.js";
import type { ImportResult } from "./index.js";

export { parseClaudeCode } from "./parseClaudeCode.js";
export {
  buildClaudeCodeManifest,
  type BuildClaudeCodeManifestOptions,
  type BuildClaudeCodeManifestResult,
} from "./buildClaudeCodeManifest.js";
export type {
  ParsedClaudeCode,
  ClaudeCodeSkill,
  ClaudeCodeMcpServer,
  ClaudeCodeHook,
  ClaudeCodeSubagent,
  ClaudeCodeCommand,
  ClaudeCodeWarning,
} from "./parseClaudeCode.js";

export type ImportClaudeCodeOptions = BuildClaudeCodeManifestOptions;

// A Claude Code config dir (~/.claude) also holds huge, irrelevant trees:
// `plugins/` marketplace clones, `projects/` session transcripts, caches, and
// the `.credentials.json` token store. Rather than walk the whole thing (and
// risk packaging a secret or blowing the file cap), we read ONLY the surfaces a
// config importer maps — by name. Everything else is never even opened.
const CONFIG_FILES = ["CLAUDE.md", "settings.json", "settings.local.json", ".mcp.json"];
const CONFIG_DIRS = ["skills", "agents", "commands"];
// Skip dependency/build noise that can live inside a skill directory.
const SUBTREE_IGNORE = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  "__pycache__",
  ".venv",
]);
const MAX_FILES = 5000;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Read a Claude Code config dir into a forward-slash relative path map. Targeted
 * (not a full tree walk): reads the known config files + the skills/agents/
 * commands subtrees, at both the root (`~/.claude` layout) and under `.claude/`
 * (project layout). `.credentials.json` and runtime caches are never touched.
 */
async function readTree(root: string): Promise<Map<string, string>> {
  const realRoot = await fs.realpath(root);
  const tree = new Map<string, string>();
  let count = 0;

  async function readFileInto(abs: string, rel: string): Promise<void> {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) return;
    if (stat.size > MAX_BYTES) return;
    if (++count > MAX_FILES) {
      throw new Error(
        `Claude Code source has more than ${MAX_FILES} config files; refusing to import.`,
      );
    }
    tree.set(rel, await fs.readFile(abs, "utf8"));
  }

  async function walkDir(absDir: string, relDir: string): Promise<void> {
    const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SUBTREE_IGNORE.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      const rel = `${relDir}/${entry.name}`;
      const stat = await fs.stat(abs).catch(() => null); // resolves symlinks
      if (stat?.isDirectory()) await walkDir(abs, rel);
      else if (stat?.isFile()) await readFileInto(abs, rel);
    }
  }

  // base = "" for the ~/.claude layout; base = ".claude" for a project layout.
  for (const base of ["", ".claude"]) {
    const absBase = base ? path.join(realRoot, base) : realRoot;
    const prefix = base ? `${base}/` : "";
    for (const f of CONFIG_FILES) {
      await readFileInto(path.join(absBase, f), `${prefix}${f}`);
    }
    for (const d of CONFIG_DIRS) {
      const absDir = path.join(absBase, d);
      const dirStat = await fs.stat(absDir).catch(() => null);
      if (dirStat?.isDirectory()) await walkDir(absDir, `${prefix}${d}`);
    }
  }
  return tree;
}

/**
 * Import a Claude Code config directory into a full AgentPack file set
 * (manifest + atom files). `rootDir` may be `~/.claude` directly or a project
 * root containing `CLAUDE.md` + `.claude/`. The result mirrors `importClaudeMd`:
 * `files[0]` is the `AGENTPACK.yaml` manifest.
 */
/** Extensions we treat as a bundleable hook script (defense: don't slurp arbitrary files). */
const HOOK_SCRIPT_EXT_RE = /\.(sh|bash|zsh|ts|mts|cts|js|mjs|cjs|py|rb|pl)$/i;
/** Interpreters we'll re-invoke a bundled script with — direct runners, no eval wrappers. */
const SAFE_HOOK_INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
]);

/** Expand a leading `$HOME` / `~` in a path token to the home directory. */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  if (p === "$HOME" || p.startsWith("$HOME/")) {
    return path.join(os.homedir(), p.slice("$HOME".length));
  }
  return p;
}

/** Derive a direct interpreter from a `#!` shebang line (env-prefix stripped). */
function interpreterFromShebang(content: string): string | undefined {
  const first = content.split("\n", 1)[0] ?? "";
  if (!first.startsWith("#!")) return undefined;
  const toks = first.slice(2).trim().split(/\s+/);
  let interp = path.basename(toks[0] ?? "");
  if (interp === "env" && toks[1]) interp = path.basename(toks[1]); // `#!/usr/bin/env bash`
  return interp || undefined;
}

/**
 * Pull the script path out of a hook command, plus the (optional) leading
 * interpreter and any trailing args. The script token is the first one with a
 * recognized script extension — so `node /usr/bin/foo $HOME/x.ts` picks `x.ts`,
 * not the interpreter path, and trailing args are preserved on the rewrite.
 */
function extractScriptRef(
  command: string,
): { interpreter?: string; rawPath: string; trailingArgs: string[] } | null {
  const toks = command.trim().split(/\s+/);
  const idx = toks.findIndex((t) => HOOK_SCRIPT_EXT_RE.test(t));
  if (idx === -1) return null; // no recognizable script token — nothing to bundle
  const prev = idx > 0 ? path.basename(toks[idx - 1]!) : undefined;
  const interpreter = prev && SAFE_HOOK_INTERPRETERS.has(prev) ? prev : undefined;
  return { interpreter, rawPath: toks[idx]!, trailingArgs: toks.slice(idx + 1) };
}

/** True when `abs` is lexically inside one of the allowed roots. */
function isInsideAny(abs: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, abs);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/**
 * Resolve a hook command to a bundled script body. Returns null (and may warn)
 * for a bare PATH binary, an unresolvable/relative path, a path OUTSIDE the
 * imported config tree / `~/.claude`, a missing/oversized/binary file, or a
 * script with no safe interpreter — in which case the importer keeps the
 * original command reference unchanged.
 */
async function resolveHookScript(
  command: string,
  rootDir: string,
  warn: (message: string) => void,
): Promise<{
  content: string;
  ext: string;
  interpreter: string;
  trailingArgs: string[];
  baseName: string;
} | null> {
  const ref = extractScriptRef(command);
  if (!ref) return null;
  const abs = expandHome(ref.rawPath);
  if (!path.isAbsolute(abs)) return null; // relative to an unknown base — skip
  if (!HOOK_SCRIPT_EXT_RE.test(abs)) return null; // only bundle things that look like scripts
  // Confine reads to the imported config tree or ~/.claude — never bundle an
  // arbitrary file elsewhere on disk (exfiltration guard for untrusted configs).
  const allowedRoots = [path.resolve(rootDir), path.join(os.homedir(), ".claude")];
  if (!isInsideAny(abs, allowedRoots)) {
    warn(
      `Hook command \`${command}\` references \`${ref.rawPath}\`, outside the imported config tree and ~/.claude — not bundled (kept as a reference).`,
    );
    return null;
  }
  const stat = await fs.stat(abs).catch(() => null); // follows symlinks (dotfiles setups)
  if (!stat?.isFile()) {
    warn(
      `Hook command \`${command}\` references \`${ref.rawPath}\`, not found on this machine — keeping the command reference (the hook may not run elsewhere).`,
    );
    return null;
  }
  if (stat.size > MAX_BYTES) return null;
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) {
    warn(`Hook script \`${ref.rawPath}\` is not text — not bundled.`);
    return null;
  }
  const content = buf.toString("utf8");
  const ext = path.extname(abs) || ".sh";
  const interpreter =
    ref.interpreter ??
    interpreterFromShebang(content) ??
    (/\.(sh|bash|zsh)$/i.test(ext) ? "bash" : undefined);
  if (!interpreter || !SAFE_HOOK_INTERPRETERS.has(interpreter)) {
    warn(`Hook script \`${ref.rawPath}\` has no recognizable interpreter — not bundled.`);
    return null;
  }
  // Positive notice: the full script body ships in the pack (secret hygiene).
  warn(
    `Bundled hook script \`${ref.rawPath}\` (${stat.size} bytes) into the pack — its full contents will ship; review before publishing.`,
  );
  return {
    content,
    ext,
    interpreter,
    trailingArgs: ref.trailingArgs,
    baseName: path.basename(abs, ext),
  };
}

export async function importClaudeCodeDir(
  rootDir: string,
  opts: ImportClaudeCodeOptions,
): Promise<ImportResult> {
  const tree = await readTree(rootDir);
  const parsed = parseClaudeCode(tree);
  // Resolve hook commands that point at real scripts and bundle their bodies, so
  // an installed hook runs on a fresh machine (#90). I/O lives here, not in the
  // pure parser; unresolvable commands keep their reference (warned).
  for (const hook of parsed.hooks) {
    const resolved = await resolveHookScript(hook.command, rootDir, (message) =>
      parsed.warnings.push({ source: "settings.json hooks", message }),
    );
    if (resolved) {
      hook.scriptContent = resolved.content;
      hook.scriptExt = resolved.ext;
      hook.interpreter = resolved.interpreter;
      hook.trailingArgs = resolved.trailingArgs;
      hook.scriptBaseName = resolved.baseName;
    }
  }
  const { manifest, files, warnings } = buildClaudeCodeManifest(parsed, opts);
  const manifestYaml = stringify(manifest, { lineWidth: 0 });
  return {
    manifest,
    files: [{ relativePath: "AGENTPACK.yaml", content: manifestYaml }, ...files],
    warnings,
  };
}
