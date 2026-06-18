// `agentpack import --from claude-code` — I/O entry. Walks a Claude Code config
// directory (`~/.claude` or a project root with `.claude/` + CLAUDE.md) into a
// path→content map, then defers to the pure parse + build pipeline.
//
// Secret hygiene: `.credentials.json` and machine-specific runtime dirs are
// never read (see IGNORE). MCP `env` surfaces KEY NAMES only — never values.

import * as fs from "node:fs/promises";
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
export async function importClaudeCodeDir(
  rootDir: string,
  opts: ImportClaudeCodeOptions,
): Promise<ImportResult> {
  const tree = await readTree(rootDir);
  const parsed = parseClaudeCode(tree);
  const { manifest, files, warnings } = buildClaudeCodeManifest(parsed, opts);
  const manifestYaml = stringify(manifest, { lineWidth: 0 });
  return {
    manifest,
    files: [{ relativePath: "AGENTPACK.yaml", content: manifestYaml }, ...files],
    warnings,
  };
}
