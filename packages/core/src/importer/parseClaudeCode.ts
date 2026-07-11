// Pure parser for a Claude Code config tree (`~/.claude` or a project's
// `.claude/` + CLAUDE.md). No I/O — `importClaudeCodeDir` (in
// ./importClaudeCode.ts) reads the filesystem and feeds a path→content map here.
//
//   - `CLAUDE.md`                    → instruction / rule sections
//   - `skills/<name>/SKILL.md`       → skill (Agent Skills format)
//   - `agents/<name>.md`             → subagent (markdown + frontmatter)
//   - `commands/<name>.md`           → command (markdown prompt + frontmatter)
//   - `settings.json` `hooks`        → hook (Claude Code event → command shape)
//   - `settings.json` `mcpServers`   → mcp_server (stdio command OR remote url)
//
// Secrets are never read: `.credentials.json` and runtime caches are skipped by
// the directory walker, and MCP `env` surfaces only KEY NAMES (never values).

import { parse as parseYaml } from "yaml";
import { parseClaudeMd, type ParsedClaudeMd } from "./parseClaudeMd.js";

export interface ClaudeCodeSkill {
  /** Directory name under `skills/` (also the skill `name`). */
  name: string;
  files: Array<{ relPath: string; content: string }>;
}

export interface ClaudeCodeMcpServer {
  name: string;
  /** "stdio" (default) for command servers, or "http"/"sse" for remote `url`. */
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface ClaudeCodeHook {
  /** Claude Code event name (PreToolUse, PostToolUse, SessionStart, …). */
  event: string;
  command: string;
  /** Tool matcher retained across Claude Code and Codex matcher groups. */
  matcher?: string;
  /**
   * Bundled script body, set by the I/O layer (`importClaudeCodeDir`) when the
   * command resolves to a readable text script. When present, the build bundles
   * the script into the pack and rewrites the command to invoke the installed
   * copy. Left unset for bare PATH binaries / unresolvable commands.
   */
  scriptContent?: string;
  /** File extension of the bundled script (e.g. `.sh`, `.ts`). */
  scriptExt?: string;
  /** Interpreter used to invoke the bundled script (e.g. `bash`, `node`). */
  interpreter?: string;
  /** Args that followed the script path in the original command (preserved). */
  trailingArgs?: string[];
  /** Source script basename without extension (used for a readable slug). */
  scriptBaseName?: string;
}

export interface ClaudeCodeSubagent {
  name: string;
  description?: string;
  instructions?: string;
  /** Verbatim source `.md` (frontmatter + body) so import preserves tools/model. */
  rawContent?: string;
}

export interface ClaudeCodeCommand {
  name: string;
  description?: string;
  /** The prompt body (markdown below the frontmatter). */
  body: string;
  argumentHint?: string;
}

export interface ClaudeCodeWarning {
  source: string;
  message: string;
}

export interface ParsedClaudeCode {
  /** Parsed CLAUDE.md, or null when the tree has none. */
  claudeMd: ParsedClaudeMd | null;
  skills: ClaudeCodeSkill[];
  subagents: ClaudeCodeSubagent[];
  commands: ClaudeCodeCommand[];
  hooks: ClaudeCodeHook[];
  mcpServers: ClaudeCodeMcpServer[];
  warnings: ClaudeCodeWarning[];
}

function norm(p: string): string {
  return p.split(/[\\/]+/).join("/");
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

/** Split a `--- yaml ---` frontmatter block from a markdown body. */
function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  if (!content.startsWith("---")) return { frontmatter: null, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: content };
  const fmText = content.slice(3, end).replace(/^\r?\n/, "");
  let frontmatter: Record<string, unknown> | null = null;
  try {
    const parsed = parseYaml(fmText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    frontmatter = null;
  }
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  return { frontmatter, body };
}

function fmString(fm: Record<string, unknown> | null, key: string): string | undefined {
  const v = fm?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Claude Code `hooks: { <Event>: [{ matcher?, hooks: [{ type, command }] }] }`. */
function parseHooks(
  value: unknown,
  warnings: ClaudeCodeWarning[],
  source: string,
): ClaudeCodeHook[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const hooks: ClaudeCodeHook[] = [];
  for (const [event, groups] of Object.entries(value as Record<string, unknown>)) {
    const groupList = Array.isArray(groups) ? groups : [groups];
    for (const group of groupList) {
      if (!group || typeof group !== "object") continue;
      const groupRecord = group as Record<string, unknown>;
      const matcher = groupRecord["matcher"];
      const portableMatcher =
        typeof matcher === "string" && matcher.trim() !== "" ? matcher.trim() : undefined;
      if (matcher !== undefined && portableMatcher === undefined) {
        warnings.push({
          source,
          message: "Hook matcher must be a non-empty string; hook group was skipped.",
        });
        continue;
      }
      const inner = groupRecord["hooks"];
      const entries = Array.isArray(inner) ? inner : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const command = (entry as Record<string, unknown>)["command"];
        if (typeof command === "string" && command.trim()) {
          hooks.push({ event, command: command.trim(), matcher: portableMatcher });
        }
      }
    }
  }
  return hooks;
}

/** Claude Code `mcpServers: { <name>: { command?, args?, env?, type?, url? } }`. */
function parseMcpServers(
  value: unknown,
  warnings: ClaudeCodeWarning[],
  source: string,
): ClaudeCodeMcpServer[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const servers: ClaudeCodeMcpServer[] = [];
  for (const [name, def] of Object.entries(value as Record<string, unknown>)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) {
      warnings.push({ source, message: `mcpServers.${name} is not an object; skipped.` });
      continue;
    }
    const d = def as Record<string, unknown>;
    const url = typeof d["url"] === "string" ? (d["url"] as string) : undefined;
    const type = typeof d["type"] === "string" ? (d["type"] as string) : undefined;
    servers.push({
      name,
      transport: url ? (type ?? "http") : "stdio",
      command: typeof d["command"] === "string" ? (d["command"] as string) : undefined,
      args: asStringArray(d["args"]),
      env: asStringRecord(d["env"]),
      url,
    });
  }
  return servers;
}

/**
 * Parse a Claude Code config tree (relative-path → content) into structured
 * primitives. Matches both a home-style tree (`~/.claude`: `CLAUDE.md`,
 * `skills/…`, `settings.json`) and a project layout (`.claude/…`). Unknown or
 * malformed files surface as warnings; never throws.
 */
export function parseClaudeCode(files: Map<string, string>): ParsedClaudeCode {
  const tree = new Map<string, string>();
  for (const [k, v] of files) tree.set(norm(k), v);

  const warnings: ClaudeCodeWarning[] = [];

  // ---------- CLAUDE.md ----------
  const claudeMdContent = tree.get("CLAUDE.md") ?? tree.get(".claude/CLAUDE.md");
  const claudeMd = claudeMdContent ? parseClaudeMd(claudeMdContent) : null;

  // ---------- settings.json (hooks + mcpServers) ----------
  let hooks: ClaudeCodeHook[] = [];
  let mcpServers: ClaudeCodeMcpServer[] = [];
  for (const settingsPath of [".claude/settings.json", "settings.json"]) {
    const raw = tree.get(settingsPath);
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      hooks = [...hooks, ...parseHooks(obj["hooks"], warnings, settingsPath)];
      mcpServers = [
        ...mcpServers,
        ...parseMcpServers(obj["mcpServers"], warnings, settingsPath),
      ];
      const unsupportedKeys = Object.keys(obj)
        .filter((key) => !["$schema", "hooks", "mcpServers"].includes(key))
        .sort();
      if (unsupportedKeys.length > 0) {
        warnings.push({
          source: settingsPath,
          message: `Unsupported Claude Code settings skipped: ${unsupportedKeys.join(", ")}.`,
        });
      }
    } catch (err) {
      warnings.push({
        source: settingsPath,
        message: `Failed to parse ${settingsPath} as JSON (${(err as Error).message}); skipped.`,
      });
    }
    break; // first match wins (.claude/ then root)
  }
  for (const localSettingsPath of [".claude/settings.local.json", "settings.local.json"]) {
    if (!tree.has(localSettingsPath)) continue;
    warnings.push({
      source: localSettingsPath,
      message: `${localSettingsPath} is machine-local and not portable; its settings were skipped.`,
    });
  }
  // Also accept a standalone .mcp.json (`{ mcpServers: {...} }`).
  const mcpJsonPath = tree.has(".mcp.json") ? ".mcp.json" : null;
  if (mcpJsonPath) {
    try {
      const obj = JSON.parse(tree.get(mcpJsonPath)!) as Record<string, unknown>;
      mcpServers = [
        ...mcpServers,
        ...parseMcpServers(obj["mcpServers"], warnings, mcpJsonPath),
      ];
    } catch (err) {
      warnings.push({
        source: mcpJsonPath,
        message: `Failed to parse ${mcpJsonPath} as JSON (${(err as Error).message}); skipped.`,
      });
    }
  }

  // ---------- skills ----------
  const skillRe = /^(?:\.claude\/)?skills\/([^/]+)\/(.+)$/;
  const skillMap = new Map<string, ClaudeCodeSkill>();
  for (const [p, content] of tree) {
    const m = p.match(skillRe);
    if (!m) continue;
    const name = m[1]!;
    let skill = skillMap.get(name);
    if (!skill) {
      skill = { name, files: [] };
      skillMap.set(name, skill);
    }
    skill.files.push({ relPath: m[2]!, content });
  }
  const skills = [...skillMap.values()]
    .filter((s) => {
      const hasSkillMd = s.files.some(
        (f) => f.relPath === "SKILL.md" || f.relPath === "skill.md",
      );
      if (!hasSkillMd) {
        warnings.push({
          source: `skills/${s.name}`,
          message: `Skill directory \`${s.name}\` has no SKILL.md; skipped.`,
        });
      }
      return hasSkillMd;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // ---------- subagents (agents/<name>.md) ----------
  const subagentRe = /^(?:\.claude\/)?agents\/([^/]+)\.md$/;
  const subagents: ClaudeCodeSubagent[] = [];
  for (const [p, content] of tree) {
    const m = p.match(subagentRe);
    if (!m) continue;
    const { frontmatter, body } = splitFrontmatter(content);
    const name = fmString(frontmatter, "name") ?? m[1]!;
    subagents.push({
      name,
      description: fmString(frontmatter, "description"),
      instructions: body.trim() || undefined,
      rawContent: content,
    });
  }
  subagents.sort((a, b) => a.name.localeCompare(b.name));

  // ---------- commands (commands/<name>.md) ----------
  const commandRe = /^(?:\.claude\/)?commands\/([^/]+)\.md$/;
  const commands: ClaudeCodeCommand[] = [];
  for (const [p, content] of tree) {
    const m = p.match(commandRe);
    if (!m) continue;
    const { frontmatter, body } = splitFrontmatter(content);
    commands.push({
      name: m[1]!,
      description: fmString(frontmatter, "description"),
      body: body.trim(),
      argumentHint: fmString(frontmatter, "argument-hint"),
    });
  }
  commands.sort((a, b) => a.name.localeCompare(b.name));

  return { claudeMd, skills, subagents, commands, hooks, mcpServers, warnings };
}
