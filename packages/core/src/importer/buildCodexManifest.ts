// Maps a parsed Codex setup into an AgentPack manifest + atom files. No I/O —
// `importCodexDir` (in ./importCodex.ts) handles the filesystem.
//
// AGENTS.md sections reuse the CLAUDE.md section logic (instruction/rule split)
// via `buildManifest`. Codex-native primitives (skills, MCP servers, hooks,
// subagents) are mapped here and round-trip back out through `adapters/codex`.

import { stringify } from "yaml";
import type {
  AgentPackManifest,
  Atom,
  PermissionsBlock,
  RiskLevel,
} from "../schema/types.js";
import { buildManifest, slugify, type ImportFile } from "./buildManifest.js";
import { importedCompatibility } from "./importCompatibility.js";
import { normalizeSkillSlug } from "../skills/agentskills.js";
import type { ParsedCodex } from "./parseCodex.js";
import type { ParseWarning } from "./parseClaudeMd.js";

export interface BuildCodexManifestOptions {
  /** `publisher.slug` — already validated by the caller. */
  id: string;
  name?: string;
  version?: string;
}

export interface BuildCodexManifestResult {
  manifest: AgentPackManifest;
  files: ImportFile[];
  warnings: ParseWarning[];
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

export function buildCodexManifest(
  parsed: ParsedCodex,
  opts: BuildCodexManifestOptions,
): BuildCodexManifestResult {
  const slug = opts.id.split(".").slice(1).join(".") || opts.id;
  const name = opts.name?.trim() || parsed.agents?.title?.trim() || slug;
  const version = opts.version?.trim() || "0.1.0";

  const files: ImportFile[] = [];
  const atoms: Atom[] = [];
  const warnings: ParseWarning[] = parsed.warnings.map((w) => ({
    line: 0,
    message: `${w.source}: ${w.message}`,
  }));
  const allocSlug = makeSlugAllocator();

  // ---------- AGENTS.md → instruction / rule atoms ----------
  if (parsed.agents && parsed.agents.sections.length > 0) {
    const base = buildManifest(parsed.agents, { id: opts.id, name, version });
    for (const atom of base.manifest.atoms) {
      // Reserve the AGENTS.md slugs so Codex-native atoms never collide.
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
    let description = `Codex skill: ${skill.name}`;
    for (const f of skill.files) {
      const isSkillMd = f.relPath.toLowerCase() === "skill.md";
      // Emit SKILL.md under the canonical name; carry bundled resources as-is.
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

  // ---------- MCP servers ----------
  const mcpServerNames: string[] = [];
  const secretsRequired: NonNullable<NonNullable<PermissionsBlock["secrets"]>["required"]> =
    [];
  for (const mcp of parsed.mcpServers) {
    if (mcp.omittedConfigKeys.length > 0) continue;
    const mcpSlug = allocSlug(slugify(mcp.name));
    const envObj: Record<string, { required: boolean }> = {};
    const requiredSecretNames = new Set<string>();
    for (const key of Object.keys(mcp.env ?? {})) {
      envObj[key] = { required: true };
      requiredSecretNames.add(key);
    }
    if (mcp.bearerTokenEnvVar) requiredSecretNames.add(mcp.bearerTokenEnvVar);
    const envHttpHeaders = mcp.config["env_http_headers"];
    if (
      envHttpHeaders &&
      typeof envHttpHeaders === "object" &&
      !Array.isArray(envHttpHeaders)
    ) {
      for (const envName of Object.values(envHttpHeaders as Record<string, unknown>)) {
        if (typeof envName === "string" && envName.trim()) requiredSecretNames.add(envName);
      }
    }
    const envVars = mcp.config["env_vars"];
    if (Array.isArray(envVars)) {
      for (const entry of envVars) {
        const envName =
          typeof entry === "string"
            ? entry
            : entry && typeof entry === "object" && !Array.isArray(entry)
              ? (entry as Record<string, unknown>)["name"]
              : undefined;
        if (typeof envName === "string" && envName.trim()) {
          requiredSecretNames.add(envName);
        }
      }
    }
    for (const secretName of requiredSecretNames) {
      secretsRequired.push({
        name: secretName,
        required_for: [`mcp_server:${mcpSlug}`],
      });
    }
    const atomObj: Record<string, unknown> = {
      id: mcpSlug,
      name: mcp.name,
      transport: mcp.transport ?? (mcp.url ? "http" : "stdio"),
      ...mcp.config,
    };
    if (mcp.command !== undefined) atomObj["command"] = mcp.command;
    if (mcp.url !== undefined) atomObj["url"] = mcp.url;
    if (mcp.args !== undefined) atomObj["args"] = mcp.args;
    if (Object.keys(envObj).length > 0) atomObj["env"] = envObj;
    if (mcp.cwd !== undefined) atomObj["cwd"] = mcp.cwd;
    if (mcp.enabledTools !== undefined) atomObj["enabled_tools"] = mcp.enabledTools;
    if (mcp.disabledTools !== undefined) atomObj["disabled_tools"] = mcp.disabledTools;
    const relativePath = `atoms/mcp/${mcpSlug}.yaml`;
    const mcpAtom: Record<string, unknown> = {
      id: `mcp_server:${mcpSlug}`,
      type: "mcp_server",
      name: mcp.name,
      description: `MCP server \`${mcp.name}\` imported from Codex.`,
      path: relativePath,
      risk_level: "high",
      permissions: ["network.access", "external_api.access"],
      transport: mcp.transport ?? (mcp.url ? "http" : "stdio"),
      ...mcp.config,
    };
    if (mcp.command !== undefined) mcpAtom["command"] = mcp.command;
    if (mcp.url !== undefined) mcpAtom["url"] = mcp.url;
    if (mcp.args !== undefined) mcpAtom["args"] = mcp.args;
    if (Object.keys(envObj).length > 0) {
      mcpAtom["env"] = envObj;
    }
    if (requiredSecretNames.size > 0) {
      (mcpAtom["permissions"] as string[]).push("secrets.env");
    }
    const codexOnlyConfig = Object.keys(mcp.config)
      .filter((key) => !["args", "command", "cwd", "name", "url"].includes(key))
      .sort();
    if (codexOnlyConfig.length > 0) {
      atomObj["codex_only_config"] = codexOnlyConfig;
      mcpAtom["codex_only_config"] = codexOnlyConfig;
    }
    files.push({ relativePath, content: stringify(atomObj, { lineWidth: 0 }) });
    mcpServerNames.push(mcpSlug);
    atoms.push(mcpAtom as unknown as Atom);
  }

  // ---------- hooks ----------
  const shellCommands = new Set<string>();
  for (const hook of parsed.hooks) {
    const hookSlug = allocSlug(slugify(`${hook.event}-${hook.command}`));
    const atomObj = {
      id: hookSlug,
      name: `${hook.event} hook`,
      events: { codex: [hook.event], "claude-code": [hook.event], generic: [hook.event] },
      handler: { kind: "shell", command: hook.command },
    };
    if (hook.matcher !== undefined) {
      (atomObj.handler as Record<string, unknown>)["matcher"] = hook.matcher;
    }
    for (const key of ["async", "timeout", "commandWindows", "statusMessage"] as const) {
      if (hook[key] !== undefined) {
        (atomObj.handler as Record<string, unknown>)[key] = hook[key];
      }
    }
    const relativePath = `atoms/hooks/${hookSlug}.yaml`;
    files.push({ relativePath, content: stringify(atomObj, { lineWidth: 0 }) });
    shellCommands.add(hook.command);
    atoms.push({
      id: `hook:${hookSlug}`,
      type: "hook",
      name: `${hook.event} hook`,
      description: `Runs \`${hook.command}\` on Codex \`${hook.event}\`.`,
      path: relativePath,
      risk_level: "high",
      permissions: ["shell.execution"],
      lifecycle: { events: { codex: [hook.event], generic: [hook.event] } },
    } as Atom);
  }

  // ---------- subagents ----------
  for (const sub of parsed.subagents) {
    if (sub.omittedConfigKeys.length > 0) continue;
    const subSlug = allocSlug(slugify(sub.name));
    const atomObj: Record<string, unknown> = {
      id: subSlug,
      name: sub.name,
    };
    if (sub.instructions !== undefined) atomObj["instructions"] = sub.instructions;
    if (Object.keys(sub.config).length > 0) atomObj["codex_config"] = sub.config;
    const relativePath = `atoms/subagents/${subSlug}.yaml`;
    files.push({ relativePath, content: stringify(atomObj, { lineWidth: 0 }) });
    atoms.push({
      id: `subagent:${subSlug}`,
      type: "subagent",
      name: sub.name,
      description: sub.description?.trim() || `Codex subagent: ${sub.name}`,
      path: relativePath,
      risk_level: "medium",
      permissions: [],
    } as Atom);
  }

  if (atoms.length === 0) {
    const warningDetails = warnings.map((warning) => warning.message).join("; ");
    throw new Error(
      `No Codex artifacts found — nothing to import. Expected AGENTS.md, .agents/skills/, .codex/config.toml, or .codex/agents/.${warningDetails ? ` Import warnings: ${warningDetails}` : ""}`,
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
      description: "Imported from Codex",
      version,
      license: "MIT",
      publisher: opts.id.split(".")[0]!,
    },
    compatibility: {
      targets: importedCompatibility(
        "codex",
        warnings.length > 0 ? "partial" : "supported",
      ),
    },
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

/** Pull a `description:` out of a SKILL.md frontmatter block, if present. */
function extractSkillDescription(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("---", 3);
  if (end === -1) return null;
  const fm = content.slice(3, end);
  const m = fm.match(/^\s*description\s*:\s*(.+)$/m);
  if (!m) return null;
  return m[1]!.trim().replace(/^["']|["']$/g, "") || null;
}
