// Pure parser for a Codex setup tree. No I/O — `importCodexDir` (in
// ./importCodex.ts) reads the filesystem and feeds a path→content map here.
//
// Codex (June 2026) shares Claude Code's primitives, so the mapping is
// near-lossless:
//   - `AGENTS.md`                       → instruction / rule sections
//   - `.agents/skills/<name>/SKILL.md`  → skill (same Agent Skills format)
//   - `config.toml [mcp_servers.*]`     → mcp_server
//   - `config.toml [hooks]` / hooks.json→ hook (event names map 1:1 to Claude)
//   - `.codex/agents/*.toml`            → subagent

import { parse as parseToml } from "smol-toml";
import { parseClaudeMd, type ParsedClaudeMd } from "./parseClaudeMd.js";
import { sanitizeCodexAgentConfig } from "../codex/customAgentConfig.js";

export interface CodexSkill {
  /** Directory name under `.agents/skills/` (also the skill `name`). */
  name: string;
  /** Every file in the skill directory, relative to the skill root. */
  files: Array<{ relPath: string; content: string }>;
}

export interface CodexMcpServer {
  name: string;
  transport?: string;
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabledTools?: string[];
  disabledTools?: string[];
  bearerTokenEnvVar?: string;
  enabled?: boolean;
  /** Schema-validated Codex-native fields carried back to Codex. */
  config: Record<string, unknown>;
  /** Unsafe, malformed, or semantically lossy fields that make this server ineligible. */
  omittedConfigKeys: string[];
}

export interface CodexHook {
  /** Codex/Claude Code event name (PreToolUse, PostToolUse, SessionStart, …). */
  event: string;
  command: string;
  matcher?: string;
}

export interface CodexSubagent {
  name: string;
  description?: string;
  instructions?: string;
  config: Record<string, unknown>;
  omittedConfigKeys: string[];
}

export interface CodexWarning {
  /** Source file the warning is about. */
  source: string;
  message: string;
}

export interface ParsedCodex {
  /** Parsed AGENTS.md, or null when the tree has none. */
  agents: ParsedClaudeMd | null;
  skills: CodexSkill[];
  mcpServers: CodexMcpServer[];
  hooks: CodexHook[];
  subagents: CodexSubagent[];
  warnings: CodexWarning[];
}

/** Normalize a tree key to forward-slash separators. */
function norm(p: string): string {
  return p.split(/[\\/]+/).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isEnvVarList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "string" ||
        (isRecord(entry) &&
          typeof entry["name"] === "string" &&
          (entry["source"] === undefined || typeof entry["source"] === "string") &&
          Object.keys(entry).every((key) => ["name", "source"].includes(key))),
    )
  );
}

function isToolConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (tool) =>
      isRecord(tool) &&
      Object.keys(tool).every((key) => key === "approval_mode") &&
      (tool["approval_mode"] === undefined ||
        ["auto", "prompt", "writes", "approve"].includes(String(tool["approval_mode"]))),
  );
}

function validMcpConfigValue(key: string, value: unknown): boolean {
  if (
    [
      "bearer_token_env_var",
      "command",
      "cwd",
      "environment_id",
      "name",
      "oauth_resource",
      "url",
    ].includes(key)
  ) {
    return typeof value === "string";
  }
  if (["args", "disabled_tools", "enabled_tools", "scopes"].includes(key)) {
    return isStringArray(value);
  }
  if (["enabled", "required", "supports_parallel_tool_calls"].includes(key)) {
    return typeof value === "boolean";
  }
  if (key === "startup_timeout_ms") {
    return Number.isInteger(value) && Number(value) >= 0;
  }
  if (["startup_timeout_sec", "tool_timeout_sec"].includes(key)) {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (key === "auth") return value === "oauth" || value === "chatgpt";
  if (key === "default_tools_approval_mode") {
    return ["auto", "prompt", "writes", "approve"].includes(String(value));
  }
  if (key === "env_http_headers") return isStringRecord(value);
  if (key === "env_vars") return isEnvVarList(value);
  if (key === "oauth") {
    return (
      isRecord(value) &&
      Object.keys(value).every((entry) => entry === "client_id") &&
      (value["client_id"] === undefined || typeof value["client_id"] === "string")
    );
  }
  if (key === "tools") return isToolConfig(value);
  return false;
}

function parseMcpServers(
  table: Record<string, unknown>,
  warnings: CodexWarning[],
  source: string,
): CodexMcpServer[] {
  const raw = table["mcp_servers"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const servers: CodexMcpServer[] = [];
  for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) {
      warnings.push({ source, message: `mcp_servers.${name} is not a table; skipped.` });
      continue;
    }
    const d = def as Record<string, unknown>;
    const safeConfigKeys = new Set([
      "args",
      "auth",
      "bearer_token_env_var",
      "command",
      "cwd",
      "default_tools_approval_mode",
      "disabled_tools",
      "enabled",
      "enabled_tools",
      "env_http_headers",
      "env_vars",
      "environment_id",
      "name",
      "oauth",
      "oauth_resource",
      "required",
      "scopes",
      "startup_timeout_ms",
      "startup_timeout_sec",
      "supports_parallel_tool_calls",
      "tool_timeout_sec",
      "tools",
      "url",
    ]);
    const unsupportedKeys = Object.keys(d)
      .filter((key) => key !== "env" && !safeConfigKeys.has(key))
      .sort();
    const malformedKeys = Object.entries(d)
      .filter(([key, value]) => safeConfigKeys.has(key) && !validMcpConfigValue(key, value))
      .map(([key]) => key)
      .sort();
    const env = d["env"];
    const malformedEnvKeys = isStringRecord(env)
      ? Object.entries(env)
          .filter(([key, value]) => value !== `\${${key}}`)
          .map(([key]) => key)
          .sort()
      : env === undefined
        ? []
        : ["env"];
    const config = Object.fromEntries(
      Object.entries(d).filter(
        ([key, value]) => safeConfigKeys.has(key) && validMcpConfigValue(key, value),
      ),
    );
    const omittedConfigKeys = [
      ...unsupportedKeys,
      ...malformedKeys,
      ...malformedEnvKeys.map((key) => `env.${key}`),
    ].sort();
    if (unsupportedKeys.length > 0) {
      warnings.push({
        source,
        message: `Omitted secret-bearing or unsupported MCP settings for ${name}: ${unsupportedKeys.join(", ")}.`,
      });
    }
    if (malformedKeys.length > 0) {
      warnings.push({
        source,
        message: `Malformed MCP settings for ${name}; server skipped: ${malformedKeys.join(", ")}.`,
      });
    }
    if (malformedEnvKeys.length > 0) {
      warnings.push({
        source,
        message: `MCP environment values for ${name} must be same-name placeholders; server skipped: ${malformedEnvKeys.join(", ")}.`,
      });
    }
    servers.push({
      name,
      transport:
        typeof d["transport"] === "string"
          ? (d["transport"] as string)
          : typeof d["url"] === "string"
            ? "http"
            : undefined,
      command: typeof d["command"] === "string" ? (d["command"] as string) : undefined,
      url: typeof d["url"] === "string" ? (d["url"] as string) : undefined,
      args: isStringArray(d["args"]) ? d["args"] : undefined,
      env: isStringRecord(env) && malformedEnvKeys.length === 0 ? env : undefined,
      cwd: typeof d["cwd"] === "string" ? (d["cwd"] as string) : undefined,
      enabledTools: isStringArray(d["enabled_tools"]) ? d["enabled_tools"] : undefined,
      disabledTools: isStringArray(d["disabled_tools"]) ? d["disabled_tools"] : undefined,
      bearerTokenEnvVar:
        typeof d["bearer_token_env_var"] === "string"
          ? (d["bearer_token_env_var"] as string)
          : undefined,
      enabled: typeof d["enabled"] === "boolean" ? (d["enabled"] as boolean) : undefined,
      config,
      omittedConfigKeys,
    });
  }
  return servers;
}

/** Extract hooks from a parsed `[hooks]` TOML table (config.toml). */
function parseTomlHooks(
  table: Record<string, unknown>,
  warnings: CodexWarning[],
  source: string,
): CodexHook[] {
  const raw = table["hooks"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return collectHookEntries(raw as Record<string, unknown>, warnings, source);
}

/** Extract hooks from a `{ hooks: { <Event>: [{command}] } }` JSON shape. */
function parseJsonHooks(
  value: unknown,
  warnings: CodexWarning[],
  source: string,
): CodexHook[] {
  let root: unknown = value;
  if (
    root &&
    typeof root === "object" &&
    !Array.isArray(root) &&
    "hooks" in (root as object)
  ) {
    root = (root as Record<string, unknown>)["hooks"];
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    warnings.push({ source, message: `${source} has no \`hooks\` object; skipped.` });
    return [];
  }
  return collectHookEntries(root as Record<string, unknown>, warnings, source);
}

/** Shared: `{ <Event>: [{command}] | {command} }` → CodexHook[]. */
function collectHookEntries(
  events: Record<string, unknown>,
  warnings: CodexWarning[],
  source: string,
): CodexHook[] {
  const hooks: CodexHook[] = [];
  for (const [event, list] of Object.entries(events)) {
    const entries = Array.isArray(list) ? list : [list];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const group = entry as Record<string, unknown>;
      if (
        Object.prototype.hasOwnProperty.call(group, "matcher") &&
        (typeof group["matcher"] !== "string" || !group["matcher"].trim())
      ) {
        warnings.push({
          source,
          message: `Hook matcher for ${event} is invalid; group skipped.`,
        });
        continue;
      }
      const matcher =
        typeof group["matcher"] === "string" && (group["matcher"] as string).trim()
          ? (group["matcher"] as string).trim()
          : undefined;
      const handlers = Array.isArray(group["hooks"]) ? (group["hooks"] as unknown[]) : [];
      if (handlers.length > 0) {
        for (const handler of handlers) {
          if (!handler || typeof handler !== "object" || Array.isArray(handler)) continue;
          const command = (handler as Record<string, unknown>)["command"];
          if (typeof command === "string" && command.trim()) {
            hooks.push({ event, command: command.trim(), matcher });
          }
        }
        continue;
      }
      const command = group["command"];
      if (typeof command === "string" && command.trim()) {
        hooks.push({ event, command: command.trim(), matcher });
      }
    }
  }
  return hooks;
}

function parseSubagent(
  content: string,
  source: string,
  warnings: CodexWarning[],
): CodexSubagent | null {
  let table: Record<string, unknown>;
  try {
    table = parseToml(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Accept either a top-level `[agent]` table or top-level keys.
  const agent =
    table["agent"] && typeof table["agent"] === "object" && !Array.isArray(table["agent"])
      ? (table["agent"] as Record<string, unknown>)
      : table;
  const configSource = agent === table ? agent : { ...table, ...agent };
  const name =
    (typeof agent["name"] === "string" && (agent["name"] as string).trim()) ||
    (typeof agent["id"] === "string" && (agent["id"] as string).trim()) ||
    "";
  if (!name) return null;
  const rawConfig = Object.fromEntries(
    Object.entries(configSource).filter(
      ([key]) =>
        ![
          "agent",
          "id",
          "name",
          "description",
          "developer_instructions",
          "instructions",
          "prompt",
        ].includes(key),
    ),
  );
  const { config, omittedKeys } = sanitizeCodexAgentConfig(rawConfig);
  if (omittedKeys.length > 0) {
    warnings.push({
      source,
      message: `Omitted security-sensitive or unsupported custom-agent settings: ${omittedKeys.join(", ")}.`,
    });
  }
  let instructions: string | undefined;
  if (Object.prototype.hasOwnProperty.call(agent, "developer_instructions")) {
    if (
      typeof agent["developer_instructions"] === "string" &&
      (agent["developer_instructions"] as string).trim() !== ""
    ) {
      instructions = agent["developer_instructions"] as string;
    } else {
      warnings.push({
        source,
        message: "Custom agent developer_instructions must be a string; omitted.",
      });
    }
  } else if (
    typeof agent["instructions"] === "string" &&
    (agent["instructions"] as string).trim() !== ""
  ) {
    instructions = agent["instructions"] as string;
    warnings.push({
      source,
      message: "Legacy custom-agent instructions key imported; use developer_instructions.",
    });
  } else if (
    typeof agent["prompt"] === "string" &&
    (agent["prompt"] as string).trim() !== ""
  ) {
    instructions = agent["prompt"] as string;
    warnings.push({
      source,
      message: "Legacy custom-agent prompt key imported; use developer_instructions.",
    });
  } else {
    warnings.push({
      source,
      message: "Custom agent is missing required developer_instructions.",
    });
  }
  const description =
    typeof agent["description"] === "string" ? (agent["description"] as string).trim() : "";
  if (!description) {
    warnings.push({
      source,
      message: "Custom agent is missing required description.",
    });
  }
  if (!instructions || !description) return null;
  return {
    name,
    description,
    instructions,
    config,
    omittedConfigKeys: omittedKeys,
  };
}

/**
 * Parse a Codex setup tree (relative-path → file content) into structured
 * primitives. `AGENTS.md` is matched at the tree root. Skills accept the
 * current `.agents/skills/` project layout plus legacy `.codex/skills/` and
 * home-style `skills/` layouts. Unknown or malformed files surface as
 * warnings, never throws.
 */
export function parseCodex(files: Map<string, string>): ParsedCodex {
  const tree = new Map<string, string>();
  for (const [k, v] of files) tree.set(norm(k), v);

  const warnings: CodexWarning[] = [];

  // ---------- AGENTS.md ----------
  const agentsContent = tree.get("AGENTS.md") ?? tree.get(".codex/AGENTS.md");
  const agents = agentsContent ? parseClaudeMd(agentsContent) : null;

  // ---------- config.toml ----------
  const configPath = tree.has(".codex/config.toml")
    ? ".codex/config.toml"
    : tree.has("config.toml")
      ? "config.toml"
      : null;
  let mcpServers: CodexMcpServer[] = [];
  let hooks: CodexHook[] = [];
  if (configPath) {
    try {
      const table = parseToml(tree.get(configPath)!) as Record<string, unknown>;
      mcpServers = parseMcpServers(table, warnings, configPath);
      hooks = parseTomlHooks(table, warnings, configPath);
      const unsupportedKeys = Object.keys(table)
        .filter((key) => !["agentpack", "hooks", "mcp_servers"].includes(key))
        .sort();
      if (unsupportedKeys.length > 0) {
        warnings.push({
          source: configPath,
          message: `Unsupported Codex config keys skipped: ${unsupportedKeys.join(", ")}.`,
        });
      }
    } catch (err) {
      warnings.push({
        source: configPath,
        message: `Failed to parse ${configPath} as TOML (${(err as Error).message}); skipped.`,
      });
    }
  }

  // ---------- hooks.json (alternative / additional hook source) ----------
  const hooksJsonPath = tree.has(".codex/hooks.json")
    ? ".codex/hooks.json"
    : tree.has("hooks.json")
      ? "hooks.json"
      : null;
  if (hooksJsonPath) {
    try {
      const parsed = JSON.parse(tree.get(hooksJsonPath)!) as unknown;
      hooks = [...hooks, ...parseJsonHooks(parsed, warnings, hooksJsonPath)];
    } catch (err) {
      warnings.push({
        source: hooksJsonPath,
        message: `Failed to parse ${hooksJsonPath} as JSON (${(err as Error).message}); skipped.`,
      });
    }
  }

  // ---------- skills ----------
  const skillRe = /^((?:\.agents|\.codex)\/skills|skills)\/([^/]+)\/(.+)$/;
  const skillMap = new Map<string, CodexSkill>();
  const skillRoots = new Map<string, Set<string>>();
  for (const [p, content] of tree) {
    const m = p.match(skillRe);
    if (!m) continue;
    const root = m[1]!;
    const name = m[2]!;
    const rel = m[3]!;
    const roots = skillRoots.get(name) ?? new Set<string>();
    roots.add(root);
    skillRoots.set(name, roots);
    let skill = skillMap.get(name);
    if (!skill) {
      skill = { name, files: [] };
      skillMap.set(name, skill);
    }
    skill.files.push({ relPath: rel, content });
  }
  const skills = [...skillMap.values()]
    .filter((s) => {
      const roots = skillRoots.get(s.name) ?? new Set<string>();
      if (roots.size > 1) {
        warnings.push({
          source: `skills/${s.name}`,
          message: `Skill exists in multiple Codex roots (${[...roots].sort().join(", ")}); skipped to avoid ambiguous overwrite.`,
        });
        return false;
      }
      const manifestNames = s.files
        .map((file) => file.relPath)
        .filter((relPath) => relPath.toLowerCase() === "skill.md");
      if (manifestNames.length > 1) {
        warnings.push({
          source: `skills/${s.name}`,
          message: `Skill contains conflicting manifest names (${manifestNames.sort().join(", ")}); skipped to avoid canonical-path overwrite.`,
        });
        return false;
      }
      const hasSkillMd = s.files.some((f) => f.relPath.toLowerCase() === "skill.md");
      if (!hasSkillMd) {
        warnings.push({
          source: `skills/${s.name}`,
          message: `Skill directory \`${s.name}\` has no SKILL.md; skipped.`,
        });
      }
      return hasSkillMd;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // ---------- subagents ----------
  const subagentRe = /^(?:\.codex\/)?agents\/([^/]+)\.toml$/;
  const subagents: CodexSubagent[] = [];
  for (const [p, content] of tree) {
    if (!subagentRe.test(p)) continue;
    const sub = parseSubagent(content, p, warnings);
    if (sub) subagents.push(sub);
    else warnings.push({ source: p, message: `Failed to parse subagent ${p}; skipped.` });
  }
  subagents.sort((a, b) => a.name.localeCompare(b.name));

  return { agents, skills, mcpServers, hooks, subagents, warnings };
}
