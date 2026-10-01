// `agentpack import --from agent-plugin` — I/O entry. Reads an Agent Plugins
// 1.0 directory (plugin.json + skills/ + mcp.json + extension namespaces) and
// defers to the existing Claude Code parse + build pipeline by synthesizing
// the equivalent config tree. The portable core (skills, MCP servers) maps
// directly; AgentPack's own extension namespace round-trips commands,
// subagents, hooks, and bundled hook scripts; foreign namespaces are surfaced
// as warnings, never dropped silently.
//
// Filesystem safety: an Agent Plugins directory is THIRD-PARTY input (unlike
// `--from claude-code`, which reads the operator's own config). Symlinks are
// followed only when their real target stays inside the plugin root (the
// spec's own containment rule); binary files are skipped with a warning
// rather than corrupted through UTF-8 decoding; and both a per-file and an
// aggregate byte budget bound what the importer will hold in memory.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringify } from "yaml";
import { parseClaudeCode } from "./parseClaudeCode.js";
import {
  buildClaudeCodeManifest,
  type BuildClaudeCodeManifestOptions,
  type ImportedMetadata,
} from "./buildClaudeCodeManifest.js";
import type { ImportResult } from "./index.js";
import { ContainedReader, type ContainedReaderWarn } from "./containedReader.js";
import {
  AGENTPACK_EXTENSION_NAMESPACE,
  validateAgentPluginManifest,
  validateAgentPluginMcpConfig,
} from "../exports/agentplugins.js";
import { agentPackManifestSchema } from "../schema/agentpack.schema.js";

export interface ImportAgentPluginOptions extends BuildClaudeCodeManifestOptions {
  /** Caller fields override plugin.json metadata; omitted fields retain it. */
  metadata?: ImportedMetadata;
}

/** A top-level directory name shaped like a reverse-domain namespace. */
const NAMESPACE_DIR_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

type Warn = ContainedReaderWarn;

/**
 * Map a spec `mcp.json` onto the Claude Code `.mcp.json` shape the existing
 * parser consumes: `streamable-http` → `http`; stdio/sse pass through. The
 * Claude pipeline cannot represent `cwd`, remote `headers`, or env VALUES
 * (env keys become required-secret declarations) — each loss is warned.
 */
function toClaudeMcpJson(specMcpJson: string, warn: Warn): string {
  const parsed = JSON.parse(specMcpJson) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    const mapped: Record<string, unknown> = { ...server };
    if (mapped["type"] === "streamable-http") mapped["type"] = "http";
    if ("cwd" in mapped) {
      warn(
        "mcp.json",
        `MCP server \`${name}\`: \`cwd\` is not representable in an AgentPack mcp_server atom — dropped; re-add it manually if the server needs a working directory.`,
      );
      delete mapped["cwd"];
    }
    if ("headers" in mapped) {
      warn(
        "mcp.json",
        `MCP server \`${name}\`: remote \`headers\` are not representable in an AgentPack mcp_server atom — dropped; configure them in the consuming client.`,
      );
      delete mapped["headers"];
    }
    const env = mapped["env"];
    if (env && typeof env === "object" && Object.keys(env).length > 0) {
      warn(
        "mcp.json",
        `MCP server \`${name}\`: env VALUES (${Object.keys(env).join(", ")}) import as required-secret key names only — AgentPack never packages env values.`,
      );
    }
    mcpServers[name] = mapped;
  }
  return JSON.stringify({ mcpServers });
}

const METADATA_SHAPE = agentPackManifestSchema.shape.metadata.shape;

/**
 * Carry a plugin.json's descriptive metadata into the pack manifest (#218).
 * Only fields the manifest schema accepts as-is are taken — each candidate
 * is parsed with the manifest's own field schema, so a non-URL `homepage` or
 * an `author` without a `name` is reported and left out rather than invented
 * or written into a manifest that would fail validation on install.
 */
function metadataFromPlugin(json: Record<string, unknown>, warn: Warn): ImportedMetadata {
  const out: ImportedMetadata = {};
  const take = <K extends keyof ImportedMetadata>(
    field: K,
    raw: unknown,
    label: string,
  ): void => {
    if (raw === undefined) return;
    const parsed = METADATA_SHAPE[field].safeParse(raw);
    if (parsed.success) {
      out[field] = parsed.data as ImportedMetadata[K];
      return;
    }
    warn(
      "plugin.json",
      `\`${label}\` was not carried into the manifest — ${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}. Set \`metadata.${field}\` by hand if wanted.`,
    );
  };
  take("description", json["description"], "description");
  take("license", json["license"], "license");
  take("homepage", json["homepage"], "homepage");
  take("repository", json["repository"], "repository");
  take("tags", json["keywords"], "keywords");
  if (json["author"] !== undefined) take("authors", [json["author"]], "author");
  return out;
}

/** Derive an interpreter for a bundled hook script from shebang or extension. */
function hookInterpreter(content: string, ext: string): string | undefined {
  const first = content.split("\n", 1)[0] ?? "";
  if (first.startsWith("#!")) {
    const toks = first.slice(2).trim().split(/\s+/);
    let interp = path.basename(toks[0] ?? "");
    if (interp === "env" && toks[1]) interp = path.basename(toks[1]);
    if (interp) return interp;
  }
  if (/^\.(sh|bash|zsh)$/i.test(ext)) return "bash";
  if (/^\.(js|mjs|cjs|ts|mts|cts)$/i.test(ext)) return "node";
  if (/^\.py$/i.test(ext)) return "python3";
  return undefined;
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
  const extraWarnings: Array<{ source: string; message: string }> = [];
  const warn: Warn = (source, message) => extraWarnings.push({ source, message });
  const reader = new ContainedReader(realRoot, warn, {
    sourceLabel: "Agent Plugins source",
    rootLabel: "plugin root",
    escapeNote: " (the Agent Plugins spec forbids symlinks that escape)",
    binaryNote: " (binary assets do not survive this importer)",
  });

  const manifestRaw = await reader.read(path.join(realRoot, "plugin.json"), "plugin.json");
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
  const skillsDir = await reader.containedDir(path.join(realRoot, "skills"), "skills");
  if (skillsDir !== null) {
    await reader.walkInto(tree, skillsDir, "skills");
  }

  // mcp.json — validate against the spec, then map onto .mcp.json.
  const mcpRaw = await reader.read(path.join(realRoot, "mcp.json"), "mcp.json");
  if (mcpRaw !== null) {
    let mcpJson: unknown = null;
    try {
      mcpJson = JSON.parse(mcpRaw);
    } catch {
      warn("mcp.json", "mcp.json is not valid JSON — MCP servers were not imported.");
    }
    if (mcpJson !== null) {
      const mcpCheck = validateAgentPluginMcpConfig(mcpJson);
      if (mcpCheck.errors.length > 0) {
        // Spec failure boundary: MCP config errors disable MCP only.
        warn(
          "mcp.json",
          `mcp.json fails Agent Plugins 1.0 validation — MCP servers were not imported: ${mcpCheck.errors.join("; ")}`,
        );
      } else {
        tree.set(".mcp.json", toClaudeMcpJson(mcpRaw, warn));
      }
    }
  }

  // Extension namespaces: ours round-trips commands/agents/hooks (+ bundled
  // hook scripts); foreign ones are reported (spec: ignore unimplemented
  // namespaces — but never silently for an importer whose job is fidelity).
  const hookScripts = new Map<string, string>();
  const rootEntries = await fs.readdir(realRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of rootEntries) {
    if (!NAMESPACE_DIR_RE.test(entry.name)) continue;
    const nsDir = await reader.containedDir(path.join(realRoot, entry.name), entry.name);
    if (nsDir === null) continue;
    if (entry.name !== AGENTPACK_EXTENSION_NAMESPACE) {
      warn(
        entry.name,
        `Extension namespace \`${entry.name}\` is not understood by AgentPack — its contents were not imported (port them manually if needed).`,
      );
      continue;
    }
    const nsRoot = nsDir;
    for (const sub of ["commands", "agents"]) {
      const abs = await reader.containedDir(path.join(nsRoot, sub), `${entry.name}/${sub}`);
      if (abs !== null) {
        await reader.walkInto(tree, abs, sub);
      }
    }
    const hooksDir = await reader.containedDir(
      path.join(nsRoot, "hooks"),
      `${entry.name}/hooks`,
    );
    if (hooksDir !== null) {
      const hooksTree = new Map<string, string>();
      await reader.walkInto(hooksTree, hooksDir, "hooks");
      const hooksRaw = hooksTree.get("hooks/hooks.json");
      if (hooksRaw !== undefined) {
        try {
          const hooks = (JSON.parse(hooksRaw) as { hooks?: unknown }).hooks;
          if (hooks) tree.set("settings.json", JSON.stringify({ hooks }));
        } catch {
          warn(
            `${entry.name}/hooks/hooks.json`,
            "hooks.json is not valid JSON — hooks were not imported.",
          );
        }
      }
      // Every other file under hooks/ is a bundled script (emitted by
      // `pack agent-plugin` from `.claude/hooks/…`) — reattach by basename.
      for (const [rel, content] of hooksTree) {
        if (rel === "hooks/hooks.json") continue;
        const base = path.basename(rel);
        if (hookScripts.has(base)) {
          warn(
            rel,
            `Duplicate bundled hook script basename \`${base}\` — kept the first occurrence; rename to disambiguate.`,
          );
          continue;
        }
        hookScripts.set(base, content);
      }
    }
  }

  // Warn for extensions declared ONLY in the manifest (no directory) — they
  // would otherwise vanish without a trace when we copy name/version out.
  if (typeof manifestJson === "object" && manifestJson !== null) {
    const extensions = (manifestJson as { extensions?: Record<string, unknown> })
      .extensions;
    for (const ns of Object.keys(extensions ?? {})) {
      if (ns !== AGENTPACK_EXTENSION_NAMESPACE) {
        warn(
          "plugin.json",
          `Extension namespace \`${ns}\` (manifest-embedded) is not understood by AgentPack — its data was not imported.`,
        );
      }
    }
  }

  const parsed = parseClaudeCode(tree);
  // Reattach bundled hook scripts so the build re-bundles them into the pack
  // (mirrors importClaudeCodeDir's resolveHookScript, but the script bodies
  // are already in-tree — no disk resolution and no path trust needed).
  for (const hook of parsed.hooks) {
    // Match on whole path basenames, not substrings — a shipped `lint.sh`
    // must not attach to a command referencing `prelint.sh`.
    const commandBasenames = new Set(
      hook.command
        .trim()
        .split(/\s+/)
        .map((token) => path.basename(token.replace(/\\/g, "/"))),
    );
    for (const [baseName, content] of hookScripts) {
      if (!commandBasenames.has(baseName)) continue;
      const ext = path.extname(baseName) || ".sh";
      const interpreter = hookInterpreter(content, ext);
      if (!interpreter) {
        warn(
          "hooks",
          `Bundled hook script \`${baseName}\` has no recognizable interpreter — kept the command reference only.`,
        );
        break;
      }
      hook.scriptContent = content;
      hook.scriptExt = ext;
      hook.interpreter = interpreter;
      hook.scriptBaseName = path.basename(baseName, ext);
      break;
    }
  }
  // Spec validation above guarantees `name` is a string and the optional
  // descriptive fields have their spec types; the manifest-schema parse in
  // metadataFromPlugin applies AgentPack's stricter rules on top. Runs before
  // the warning flush below so its own warnings are not lost.
  const pluginMeta = manifestJson as Record<string, unknown> & { name: string };
  const metadata = metadataFromPlugin(pluginMeta, warn);

  parsed.warnings.push(...extraWarnings);
  for (const w of manifestCheck.warnings) {
    parsed.warnings.push({ source: "plugin.json", message: w });
  }

  const { manifest, files, warnings } = buildClaudeCodeManifest(parsed, {
    ...opts,
    name: opts.name ?? pluginMeta.name,
    version: opts.version ?? (pluginMeta["version"] as string | undefined),
    metadata: { ...metadata, ...opts.metadata },
  });
  const manifestYaml = stringify(manifest, { lineWidth: 0 });
  return {
    manifest,
    files: [{ relativePath: "AGENTPACK.yaml", content: manifestYaml }, ...files],
    warnings,
  };
}
