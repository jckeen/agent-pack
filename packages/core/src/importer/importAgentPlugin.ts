// `agentpack import --from agent-plugin` — I/O entry. Reads an Agent Plugins
// 1.0 directory (plugin.json + skills/ + mcp.json + extension namespaces) and
// defers to the existing Claude Code parse + build pipeline by synthesizing
// the equivalent config tree. The portable core (skills, MCP servers) maps
// directly; AgentPack's own extension namespace round-trips commands,
// subagents, and hooks; foreign namespaces are surfaced as warnings, never
// dropped silently.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringify } from "yaml";
import { parseClaudeCode } from "./parseClaudeCode.js";
import {
  buildClaudeCodeManifest,
  type BuildClaudeCodeManifestOptions,
} from "./buildClaudeCodeManifest.js";
import type { ImportResult } from "./index.js";
import {
  AGENTPACK_EXTENSION_NAMESPACE,
  validateAgentPluginManifest,
  validateAgentPluginMcpConfig,
} from "../exports/agentplugins.js";

export type ImportAgentPluginOptions = BuildClaudeCodeManifestOptions;

const MAX_FILES = 5000;
const MAX_BYTES = 5 * 1024 * 1024;
const SUBTREE_IGNORE = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  "__pycache__",
  ".venv",
]);

/** A top-level directory name shaped like a reverse-domain namespace. */
const NAMESPACE_DIR_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

async function readFileIfSmall(abs: string): Promise<string | null> {
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_BYTES) return null;
  return fs.readFile(abs, "utf8");
}

async function walkInto(
  tree: Map<string, string>,
  absDir: string,
  relDir: string,
): Promise<void> {
  const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (SUBTREE_IGNORE.has(entry.name)) continue;
    if (tree.size > MAX_FILES) {
      throw new Error(
        `Agent Plugins source has more than ${MAX_FILES} files; refusing to import.`,
      );
    }
    const abs = path.join(absDir, entry.name);
    const rel = `${relDir}/${entry.name}`;
    const stat = await fs.stat(abs).catch(() => null); // resolves symlinks
    if (stat?.isDirectory()) await walkInto(tree, abs, rel);
    else if (stat?.isFile() && stat.size <= MAX_BYTES) {
      tree.set(rel, await fs.readFile(abs, "utf8"));
    }
  }
}

/**
 * Map a spec `mcp.json` onto the Claude Code `.mcp.json` shape the existing
 * parser consumes: `streamable-http` → `http`; stdio/sse pass through.
 */
function toClaudeMcpJson(specMcpJson: string): string {
  const parsed = JSON.parse(specMcpJson) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    if (server["type"] === "streamable-http") {
      mcpServers[name] = { ...server, type: "http" };
    } else {
      mcpServers[name] = server;
    }
  }
  return JSON.stringify({ mcpServers });
}

/**
 * Import an Agent Plugins 1.0 directory into a full AgentPack file set
 * (manifest + atom files). The directory must contain a valid `plugin.json`
 * at its root; spec validation errors fail the import (a package that
 * conformant clients would reject is not worth silently repackaging).
 */
export async function importAgentPluginDir(
  rootDir: string,
  opts: ImportAgentPluginOptions,
): Promise<ImportResult> {
  const realRoot = await fs.realpath(rootDir);
  const manifestRaw = await readFileIfSmall(path.join(realRoot, "plugin.json"));
  if (manifestRaw === null) {
    throw new Error(`No plugin.json found in ${rootDir} — not an Agent Plugins directory.`);
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (err) {
    throw new Error(`plugin.json is not valid JSON: ${(err as Error).message}`);
  }
  const manifestCheck = validateAgentPluginManifest(manifestJson);
  if (manifestCheck.errors.length > 0) {
    throw new Error(
      `plugin.json fails Agent Plugins 1.0 validation:\n${manifestCheck.errors
        .map((e) => `  • ${e}`)
        .join("\n")}`,
    );
  }

  // Synthesize the Claude Code config tree the existing pipeline understands.
  const tree = new Map<string, string>();

  // skills/ — fixed portable location; SKILL.md at immediate child level only
  // per the spec, but supporting files below each skill dir carry through.
  const skillsDir = path.join(realRoot, "skills");
  if ((await fs.stat(skillsDir).catch(() => null))?.isDirectory()) {
    await walkInto(tree, skillsDir, "skills");
  }

  // mcp.json — validate against the spec, then map onto .mcp.json.
  const mcpRaw = await readFileIfSmall(path.join(realRoot, "mcp.json"));
  const extraWarnings: Array<{ source: string; message: string }> = [];
  if (mcpRaw !== null) {
    let mcpJson: unknown = null;
    try {
      mcpJson = JSON.parse(mcpRaw);
    } catch {
      extraWarnings.push({
        source: "mcp.json",
        message: "mcp.json is not valid JSON — MCP servers were not imported.",
      });
    }
    if (mcpJson !== null) {
      const mcpCheck = validateAgentPluginMcpConfig(mcpJson);
      if (mcpCheck.errors.length > 0) {
        // Spec failure boundary: MCP config errors disable MCP only.
        extraWarnings.push({
          source: "mcp.json",
          message: `mcp.json fails Agent Plugins 1.0 validation — MCP servers were not imported: ${mcpCheck.errors.join("; ")}`,
        });
      } else {
        tree.set(".mcp.json", toClaudeMcpJson(mcpRaw));
      }
    }
  }

  // Extension namespaces: ours round-trips commands/agents/hooks; foreign
  // ones are reported (spec: ignore unimplemented namespaces — but never
  // silently for an importer whose job is fidelity).
  const rootEntries = await fs.readdir(realRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of rootEntries) {
    const stat = await fs.stat(path.join(realRoot, entry.name)).catch(() => null);
    if (!stat?.isDirectory() || !NAMESPACE_DIR_RE.test(entry.name)) continue;
    if (entry.name !== AGENTPACK_EXTENSION_NAMESPACE) {
      extraWarnings.push({
        source: entry.name,
        message: `Extension namespace \`${entry.name}\` is not understood by AgentPack — its contents were not imported (port them manually if needed).`,
      });
      continue;
    }
    const nsRoot = path.join(realRoot, entry.name);
    for (const sub of ["commands", "agents"]) {
      const abs = path.join(nsRoot, sub);
      if ((await fs.stat(abs).catch(() => null))?.isDirectory()) {
        await walkInto(tree, abs, sub);
      }
    }
    const hooksRaw = await readFileIfSmall(path.join(nsRoot, "hooks", "hooks.json"));
    if (hooksRaw !== null) {
      try {
        const hooks = (JSON.parse(hooksRaw) as { hooks?: unknown }).hooks;
        if (hooks) tree.set("settings.json", JSON.stringify({ hooks }));
      } catch {
        extraWarnings.push({
          source: `${entry.name}/hooks/hooks.json`,
          message: "hooks.json is not valid JSON — hooks were not imported.",
        });
      }
    }
  }

  const parsed = parseClaudeCode(tree);
  parsed.warnings.push(...extraWarnings);
  for (const w of manifestCheck.warnings) {
    parsed.warnings.push({ source: "plugin.json", message: w });
  }

  const pluginMeta = manifestJson as {
    name: string;
    version?: string;
    description?: string;
  };
  const { manifest, files, warnings } = buildClaudeCodeManifest(parsed, {
    ...opts,
    name: opts.name ?? pluginMeta.name,
    version: opts.version ?? pluginMeta.version,
  });
  const manifestYaml = stringify(manifest, { lineWidth: 0 });
  return {
    manifest,
    files: [{ relativePath: "AGENTPACK.yaml", content: manifestYaml }, ...files],
    warnings,
  };
}
