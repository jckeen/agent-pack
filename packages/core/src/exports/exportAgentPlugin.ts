import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  AdapterOutputFile,
  AgentPackManifest,
  AtomType,
  InstallPlan,
} from "../schema/types.js";
import { getAdapter } from "../adapters/index.js";
import { loadManifest } from "../parser/loadManifest.js";
import { validateManifest } from "../validator/validateManifest.js";
import { createInstallPlan } from "../planner/createInstallPlan.js";
import { UnknownProfileError } from "../planner/resolveAtoms.js";
import { stableJsonStringify } from "../adapters/types.js";
import { summarizePortability, type PortabilitySummary } from "../portability.js";
import { normalizeSkillSlug, renderSkillMd } from "../skills/agentskills.js";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
  AGENT_PLUGIN_MCP_SCHEMA_ID,
  AGENTPACK_EXTENSION_NAMESPACE,
  normalizeAgentPluginName,
  type AgentPluginManifest,
  type AgentPluginMcpServer,
} from "./agentplugins.js";

export interface ExportAgentPluginOptions {
  /** Path to the pack directory or AGENTPACK.yaml file. */
  source: string;
  profile?: string;
  outDir: string;
  strict?: boolean;
  onlyAtoms?: string[];
  allowMissingBodies?: boolean;
}

export interface ExportAgentPluginResult {
  plan: InstallPlan;
  writtenFiles: string[];
  outDir: string;
  pluginName: string;
  portability: PortabilitySummary;
  /**
   * Files emitted under the AgentPack extension namespace directory — the
   * components Agent Plugins v1 declares non-portable (commands, subagents,
   * hooks). Only namespace-aware clients (and `agentpack import`) read them.
   */
  extensionFiles: string[];
}

const MISSING_BODY_WARNING_PATTERNS = [
  /directory not found at/i,
  /minimal SKILL\.md/i,
  /not found at `/i,
];

function mk(filePath: string, content: string): AdapterOutputFile {
  return { path: filePath, content, action: "create" };
}

/**
 * Compile an AgentPack into an **Agent Plugins 1.0** directory — the
 * cross-vendor package standard (agent-plugins.org) loaded natively by VS
 * Code, GitHub Copilot, Cursor, ChatGPT, Kiro, and other clients.
 *
 * Reuses the `claude-code` adapter's rendering and relocates it into the
 * spec layout: `plugin.json` (closed root manifest), `skills/…` (Agent
 * Skills, portable), `mcp.json` (spec transport config, portable), and the
 * spec's reverse-domain extension namespace directory for everything the
 * spec declares non-portable in v1 (commands, subagents, hooks).
 * Instruction/rule content bridges as an on-invoke guidance skill — the same
 * honest ceiling as `pack plugin`.
 */
export async function exportAgentPlugin(
  options: ExportAgentPluginOptions,
): Promise<ExportAgentPluginResult> {
  const strict = options.strict ?? true;
  const allowMissing = options.allowMissingBodies ?? false;
  const loaded = await loadManifest(options.source);
  const validation = validateManifest(loaded.manifest);
  if (!validation.valid && strict) {
    const detail = validation.errors
      .map((e) => `[${e.code}] ${e.path}: ${e.message}`)
      .join("\n");
    throw new Error(`AgentPack manifest failed validation:\n${detail}`);
  }

  const adapter = getAdapter("claude-code");
  const profile = resolveProfile(loaded.manifest, options.profile);
  const plan = await createInstallPlan({
    manifest: loaded.manifest,
    packRoot: loaded.packRoot,
    target: "claude-code",
    profile,
    adapter,
    onlyAtoms: options.onlyAtoms,
  });

  if (strict && !allowMissing) {
    const missing = plan.warnings.filter((w) =>
      MISSING_BODY_WARNING_PATTERNS.some((rx) => rx.test(w)),
    );
    if (missing.length > 0) {
      throw new Error(
        `Agent Plugins export aborted: atom body files missing — exporting would produce a degenerate plugin.\n` +
          missing.map((w) => `  • ${w}`).join("\n") +
          `\nFix the manifest paths, or pass --allow-missing.`,
      );
    }
  }

  const pluginName = normalizeAgentPluginName(loaded.manifest.metadata.slug);
  const pluginFiles = toAgentPluginFiles(plan, loaded.manifest, pluginName, profile);

  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const file of pluginFiles) {
    const absPath = path.resolve(outDir, file.path);
    if (!isInside(outDir, absPath)) {
      throw new Error(`Refusing to write outside outDir: ${file.path}`);
    }
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      file.content.endsWith("\n") ? file.content : `${file.content}\n`,
      "utf8",
    );
    written.push(path.relative(outDir, absPath));
  }

  const types = atomTypesForPlan(plan, loaded.manifest);
  return {
    plan,
    writtenFiles: written,
    outDir,
    pluginName,
    portability: summarizePortability(types),
    extensionFiles: written.filter((p) =>
      p.startsWith(`${AGENTPACK_EXTENSION_NAMESPACE}/`),
    ),
  };
}

/** Relocate claude-code adapter output into Agent Plugins 1.0 layout. */
function toAgentPluginFiles(
  plan: InstallPlan,
  manifest: AgentPackManifest,
  pluginName: string,
  profile: string,
): AdapterOutputFile[] {
  const out: AdapterOutputFile[] = [];

  for (const f of plan.files) {
    if (f.path === "CLAUDE.md") {
      // Instructions/rules are not a portable v1 component. Bridge as an
      // on-invoke skill (portable) — same honest ceiling as `pack plugin`.
      const guidanceName = normalizeSkillSlug(`${pluginName}-guidance`);
      out.push(
        mk(
          `skills/${guidanceName}/SKILL.md`,
          guidanceSkill(manifest, guidanceName, f.content),
        ),
      );
      continue;
    }
    if (f.path === ".claude/settings.json") {
      // Hooks are explicitly not portable in v1 → extension namespace.
      const hooks = extractHooks(f.content);
      if (hooks) {
        out.push(
          mk(
            `${AGENTPACK_EXTENSION_NAMESPACE}/hooks/hooks.json`,
            stableJsonStringify({ hooks }),
          ),
        );
      }
      continue;
    }
    if (f.path === ".mcp.json") {
      const converted = toSpecMcpJson(f.content, plan);
      if (converted) out.push(mk("mcp.json", converted));
      continue;
    }
    if (f.path.startsWith(".claude/skills/")) {
      // Portable fixed location: skills/ at the plugin root.
      out.push(mk(f.path.slice(".claude/".length), f.content));
      continue;
    }
    if (f.path.startsWith(".claude/")) {
      // Commands, subagents, and any other Claude-Code-specific surface are
      // not portable v1 components → extension namespace directory.
      out.push(
        mk(
          `${AGENTPACK_EXTENSION_NAMESPACE}/${f.path.slice(".claude/".length)}`,
          f.content,
        ),
      );
      continue;
    }
    // Anything else (READMEs etc.) passes through at root.
    out.push(f);
  }

  out.unshift(
    mk(
      "plugin.json",
      stableJsonStringify(
        pluginManifest(manifest, pluginName, profile, out) as unknown as Record<
          string,
          unknown
        >,
      ),
    ),
  );
  return out;
}

/**
 * Convert the claude-code adapter's `.mcp.json` into a spec `mcp.json`.
 *
 * Transport mapping: `http` → `streamable-http`; `stdio`/`sse` unchanged.
 * The adapter writes env values as `${KEY}` placeholders that Claude Code
 * expands from the user environment — the spec expands only `${PLUGIN_ROOT}`
 * and `${PLUGIN_DATA}`, so those placeholders would land as literal strings.
 * They are dropped, and the required key names are recorded as a plan warning
 * (the operator provides them through the client's own mechanism).
 */
function toSpecMcpJson(claudeMcpJson: string, plan: InstallPlan): string | null {
  let parsed: { mcpServers?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(claudeMcpJson) as typeof parsed;
  } catch {
    return null;
  }
  const servers: Record<string, AgentPluginMcpServer> = {};
  for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
    const type = raw["type"];
    if (type === "stdio" && typeof raw["command"] === "string") {
      const envKeys = Object.keys(
        (raw["env"] as Record<string, unknown> | undefined) ?? {},
      );
      if (envKeys.length > 0) {
        plan.warnings.push(
          `MCP server \`${name}\`: env placeholder(s) ${envKeys.join(", ")} omitted from mcp.json — Agent Plugins expands only \${PLUGIN_ROOT}/\${PLUGIN_DATA}; provide these through the client's environment.`,
        );
      }
      servers[name] = {
        type: "stdio",
        command: raw["command"],
        args: (raw["args"] as string[] | undefined) ?? [],
      };
    } else if (
      (type === "http" || type === "streamable-http" || type === "sse") &&
      typeof raw["url"] === "string"
    ) {
      servers[name] = {
        type: type === "sse" ? "sse" : "streamable-http",
        url: raw["url"],
      };
    }
  }
  if (Object.keys(servers).length === 0) return null;
  return stableJsonStringify({
    $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
    mcpServers: servers,
  });
}

function pluginManifest(
  manifest: AgentPackManifest,
  pluginName: string,
  profile: string,
  files: AdapterOutputFile[],
): AgentPluginManifest {
  const m = manifest.metadata;
  const author = m.authors?.[0];
  const json: AgentPluginManifest = {
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
    name: pluginName,
    version: m.version,
    description: m.description,
  };
  if (author) {
    json.author = {
      name: author.name,
      ...(author.email ? { email: author.email } : {}),
      ...(author.url ? { url: author.url } : {}),
    };
  }
  if (m.homepage) json.homepage = m.homepage;
  if (m.repository) json.repository = m.repository;
  if (m.license) json.license = m.license;
  if (m.tags && m.tags.length > 0) json.keywords = m.tags;

  // AgentPack governance rides in the spec's extensions namespace: pack
  // identity + provenance for `agentpack import` round-trips and for clients
  // that understand AgentPack's risk/permission model.
  const extensionDirs = [
    ...new Set(
      files
        .filter((f) => f.path.startsWith(`${AGENTPACK_EXTENSION_NAMESPACE}/`))
        .map((f) => f.path.split("/").slice(0, 2).join("/")),
    ),
  ].sort();
  json.extensions = {
    [AGENTPACK_EXTENSION_NAMESPACE]: {
      agentpack: manifest.agentpack,
      pack: {
        id: m.id,
        slug: m.slug,
        version: m.version,
        publisher: m.publisher,
      },
      profile,
      ...(manifest.security?.risk_level
        ? { risk_level: manifest.security.risk_level }
        : {}),
      ...(extensionDirs.length > 0 ? { component_dirs: extensionDirs } : {}),
    },
  };
  return json;
}

function guidanceSkill(manifest: AgentPackManifest, name: string, body: string): string {
  const trimmed = body.replace(/^#\s.*\n+/, "").trimEnd();
  return renderSkillMd(
    {
      name,
      description: `${manifest.metadata.name} standards and rules. Bundled from the pack's instruction/rule atoms — Agent Plugins v1 has no ambient-instruction component; invoke this skill to apply the guidance.`,
    },
    trimmed,
  );
}

function extractHooks(settingsJson: string): unknown | null {
  try {
    const parsed = JSON.parse(settingsJson) as { hooks?: unknown };
    if (parsed.hooks && Object.keys(parsed.hooks).length > 0) {
      return parsed.hooks;
    }
  } catch {
    // Malformed settings — skip rather than emit broken hooks.
  }
  return null;
}

function atomTypesForPlan(plan: InstallPlan, manifest: AgentPackManifest): AtomType[] {
  const typeById = new Map<string, AtomType>(manifest.atoms.map((a) => [a.id, a.type]));
  return plan.atoms
    .map((id) => typeById.get(id))
    .filter((t): t is AtomType => t !== undefined);
}

function resolveProfile(
  manifest: {
    profiles: Record<string, unknown>;
    exports?: { default_profile?: string };
  },
  requested?: string,
): string {
  if (requested) {
    if (!manifest.profiles[requested]) {
      throw new UnknownProfileError(requested, Object.keys(manifest.profiles));
    }
    return requested;
  }
  const declaredDefault = manifest.exports?.default_profile;
  if (declaredDefault && manifest.profiles[declaredDefault]) {
    return declaredDefault;
  }
  if (manifest.profiles.safe) return "safe";
  const declared = Object.keys(manifest.profiles).join(", ");
  throw new Error(
    `No profile specified and pack declares no \`exports.default_profile\` (or \`safe\`). Specify --profile <one of: ${declared}>.`,
  );
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
