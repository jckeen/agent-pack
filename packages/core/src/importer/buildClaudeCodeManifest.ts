// Maps a parsed Claude Code config into an AgentPack manifest + atom files. No
// I/O — `importClaudeCodeDir` (in ./importClaudeCode.ts) handles the filesystem.
//
// CLAUDE.md sections reuse the instruction/rule split via `buildManifest`.
// Claude-Code-native primitives (skills, commands, subagents, hooks, MCP
// servers) are mapped here and round-trip back out through `adapters/claudeCode`.

import { stringify } from "yaml";
import type {
  AgentPackManifest,
  Atom,
  CompatibilityMap,
  PermissionsBlock,
  RiskLevel,
  TargetPlatform,
} from "../schema/types.js";
import { TARGET_PLATFORMS } from "../schema/types.js";
import { buildManifest, slugify, type ImportFile } from "./buildManifest.js";
import { normalizeSkillSlug } from "../skills/agentskills.js";
import type { ParsedClaudeCode } from "./parseClaudeCode.js";
import type { ParseWarning } from "./parseClaudeMd.js";

export interface BuildClaudeCodeManifestOptions {
  /** `publisher.slug` — already validated by the caller. */
  id: string;
  name?: string;
  version?: string;
}

export interface BuildClaudeCodeManifestResult {
  manifest: AgentPackManifest;
  files: ImportFile[];
  warnings: ParseWarning[];
}

function defaultTargets(): CompatibilityMap {
  const targets: CompatibilityMap = {};
  for (const t of TARGET_PLATFORMS) {
    targets[t as TargetPlatform] = { status: "supported" };
  }
  return targets;
}

/** Unique-slug allocator shared across every atom kind. */
function makeSlugAllocator() {
  const used = new Map<string, number>();
  return (base: string): string => {
    const seen = used.get(base);
    if (seen === undefined) {
      used.set(base, 1);
      return base;
    }
    const next = seen + 1;
    used.set(base, next);
    return `${base}-${next}`;
  };
}

const MAX_RISK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return MAX_RISK[a] >= MAX_RISK[b] ? a : b;
}

function extractSkillDescription(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("---", 3);
  if (end === -1) return null;
  const fm = content.slice(3, end);
  const m = fm.match(/^\s*description\s*:\s*(.+)$/m);
  if (!m) return null;
  return m[1]!.trim().replace(/^["']|["']$/g, "") || null;
}

export function buildClaudeCodeManifest(
  parsed: ParsedClaudeCode,
  opts: BuildClaudeCodeManifestOptions,
): BuildClaudeCodeManifestResult {
  const slug = opts.id.split(".").slice(1).join(".") || opts.id;
  const name = opts.name?.trim() || parsed.claudeMd?.title?.trim() || slug;
  const version = opts.version?.trim() || "0.1.0";

  const files: ImportFile[] = [];
  const atoms: Atom[] = [];
  const warnings: ParseWarning[] = parsed.warnings.map((w) => ({
    line: 0,
    message: `${w.source}: ${w.message}`,
  }));
  const allocSlug = makeSlugAllocator();

  // ---------- CLAUDE.md → instruction / rule atoms ----------
  if (parsed.claudeMd && parsed.claudeMd.sections.length > 0) {
    const base = buildManifest(parsed.claudeMd, { id: opts.id, name, version });
    for (const atom of base.manifest.atoms) {
      allocSlug(atom.id.split(":")[1] ?? atom.id);
      atoms.push(atom);
    }
    files.push(...base.files);
    warnings.push(...base.warnings);
  }

  // ---------- skills ----------
  for (const skill of parsed.skills) {
    const skillSlug = allocSlug(normalizeSkillSlug(skill.name));
    const dir = `atoms/skills/${skillSlug}`;
    let description = `Claude Code skill: ${skill.name}`;
    for (const f of skill.files) {
      const isSkillMd = f.relPath === "SKILL.md" || f.relPath === "skill.md";
      const outRel = isSkillMd ? "SKILL.md" : f.relPath;
      files.push({ relativePath: `${dir}/${outRel}`, content: f.content });
      if (isSkillMd) {
        const desc = extractSkillDescription(f.content);
        if (desc) description = desc;
      }
    }
    atoms.push({
      id: `skill:${skillSlug}`,
      type: "skill",
      name: skill.name,
      description,
      path: dir,
      risk_level: "low",
      permissions: [],
      skill_format: "agent-skills",
    } as Atom);
  }

  // ---------- commands ----------
  for (const cmd of parsed.commands) {
    const cmdSlug = allocSlug(slugify(cmd.name));
    const promptPath = `atoms/commands/prompts/${cmdSlug}.md`;
    const descriptorPath = `atoms/commands/${cmdSlug}.yaml`;
    files.push({ relativePath: promptPath, content: `${cmd.body || `# ${cmd.name}`}\n` });
    const descriptor: Record<string, unknown> = {
      id: cmdSlug,
      name: cmd.name,
      invocation: { slash: `/${cmdSlug}` },
      prompt: promptPath,
    };
    files.push({
      relativePath: descriptorPath,
      content: stringify(descriptor, { lineWidth: 0 }),
    });
    atoms.push({
      id: `command:${cmdSlug}`,
      type: "command",
      name: cmd.name,
      description:
        cmd.description?.trim() || `\`/${cmdSlug}\` command imported from Claude Code.`,
      path: descriptorPath,
      risk_level: "low",
      permissions: [],
      invocation: { slash: `/${cmdSlug}` },
    } as Atom);
  }

  // ---------- subagents ----------
  for (const sub of parsed.subagents) {
    const subSlug = allocSlug(slugify(sub.name));
    const atomObj: Record<string, unknown> = { id: subSlug, name: sub.name };
    if (sub.instructions !== undefined) atomObj["instructions"] = sub.instructions;
    const relativePath = `atoms/subagents/${subSlug}.yaml`;
    files.push({ relativePath, content: stringify(atomObj, { lineWidth: 0 }) });
    atoms.push({
      id: `subagent:${subSlug}`,
      type: "subagent",
      name: sub.name,
      description: sub.description?.trim() || `Claude Code subagent: ${sub.name}`,
      path: relativePath,
      risk_level: "medium",
      permissions: [],
    } as Atom);
  }

  // ---------- hooks ----------
  const shellCommands = new Set<string>();
  for (const hook of parsed.hooks) {
    const hookSlug = allocSlug(slugify(`${hook.event}-${hook.command}`));
    const atomObj = {
      id: hookSlug,
      name: `${hook.event} hook`,
      events: { "claude-code": [hook.event], codex: [hook.event], generic: [hook.event] },
      handler: { kind: "shell", command: hook.command },
    };
    const relativePath = `atoms/hooks/${hookSlug}.yaml`;
    files.push({ relativePath, content: stringify(atomObj, { lineWidth: 0 }) });
    shellCommands.add(hook.command);
    atoms.push({
      id: `hook:${hookSlug}`,
      type: "hook",
      name: `${hook.event} hook`,
      description: `Runs \`${hook.command}\` on Claude Code \`${hook.event}\`.`,
      path: relativePath,
      risk_level: "high",
      permissions: ["shell.execution"],
      lifecycle: { events: { "claude-code": [hook.event], generic: [hook.event] } },
    } as Atom);
  }

  // ---------- MCP servers ----------
  const mcpServerNames: string[] = [];
  const secretsRequired: NonNullable<NonNullable<PermissionsBlock["secrets"]>["required"]> =
    [];
  for (const mcp of parsed.mcpServers) {
    const mcpSlug = allocSlug(slugify(mcp.name));
    const envObj: Record<string, { required: boolean }> = {};
    for (const key of Object.keys(mcp.env ?? {})) {
      envObj[key] = { required: true };
      secretsRequired.push({ name: key, required_for: [`mcp_server:${mcpSlug}`] });
    }
    const transport = mcp.transport ?? "stdio";
    const descriptor: Record<string, unknown> = { id: mcpSlug, name: mcp.name, transport };
    if (mcp.url !== undefined) descriptor["url"] = mcp.url;
    if (mcp.command !== undefined) descriptor["command"] = mcp.command;
    if (mcp.args !== undefined) descriptor["args"] = mcp.args;
    if (Object.keys(envObj).length > 0) descriptor["env"] = envObj;
    const relativePath = `atoms/mcp/${mcpSlug}.yaml`;
    files.push({ relativePath, content: stringify(descriptor, { lineWidth: 0 }) });
    mcpServerNames.push(mcpSlug);
    const mcpAtom: Record<string, unknown> = {
      id: `mcp_server:${mcpSlug}`,
      type: "mcp_server",
      name: mcp.name,
      description: `MCP server \`${mcp.name}\` imported from Claude Code.`,
      path: relativePath,
      risk_level: "high",
      permissions: ["network.access", "external_api.access"],
      transport,
    };
    if (mcp.url !== undefined) mcpAtom["url"] = mcp.url;
    if (mcp.command !== undefined) mcpAtom["command"] = mcp.command;
    if (mcp.args !== undefined) mcpAtom["args"] = mcp.args;
    if (Object.keys(envObj).length > 0) {
      mcpAtom["env"] = envObj;
      (mcpAtom["permissions"] as string[]).push("secrets.env");
    }
    atoms.push(mcpAtom as unknown as Atom);
  }

  if (atoms.length === 0) {
    throw new Error(
      "No Claude Code artifacts found — nothing to import. Expected CLAUDE.md, skills/, agents/, commands/, or settings.json (hooks/mcpServers).",
    );
  }

  // ---------- permissions (declare what the atoms imply) ----------
  const permissions: PermissionsBlock = {};
  if (shellCommands.size > 0) {
    permissions.shell = { execution: "optional", commands: [...shellCommands].sort() };
  }
  if (mcpServerNames.length > 0) {
    permissions.mcp = { servers: mcpServerNames };
    permissions.network = { access: "optional" };
    permissions.external_apis = mcpServerNames;
  }
  if (secretsRequired.length > 0) {
    permissions.secrets = { required: secretsRequired };
  }

  // ---------- overall risk ----------
  let riskLevel: RiskLevel = "low";
  for (const atom of atoms) riskLevel = maxRisk(riskLevel, atom.risk_level);

  const manifest: AgentPackManifest = {
    agentpack: "1.0",
    metadata: {
      id: opts.id,
      name,
      slug,
      description: "Imported from Claude Code",
      version,
      license: "MIT",
      publisher: opts.id.split(".")[0]!,
    },
    compatibility: { targets: defaultTargets() },
    permissions,
    security: { risk_level: riskLevel },
    profiles: {
      all: { description: "All imported atoms.", include: ["*"] },
    },
    atoms,
    exports: { default_profile: "all" },
  };

  return { manifest, files, warnings };
}
