// Public TypeScript types for AgentPack.
//
// These mirror `schemas/AGENTPACK.schema.json` and the bundled spec docs. The
// runtime zod schema in ./agentpack.schema.ts is the source of truth for
// validation. This file is the source of truth for the *static* developer
// experience — consumers should import from `@agentpack/core` (re-exported in
// the package entry).

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type TargetPlatform = "claude-code" | "codex" | "cursor" | "chatgpt" | "generic";

export type CompatibilityStatus = "supported" | "partial" | "experimental" | "unsupported";

export type AtomType =
  | "instruction"
  | "rule"
  | "skill"
  | "hook"
  | "command"
  | "subagent"
  | "mcp_server"
  | "plugin"
  | "workflow"
  | "context_pack"
  | "template"
  | "eval";

export const ATOM_TYPES: readonly AtomType[] = [
  "instruction",
  "rule",
  "skill",
  "hook",
  "command",
  "subagent",
  "mcp_server",
  "plugin",
  "workflow",
  "context_pack",
  "template",
  "eval",
] as const;

export const TARGET_PLATFORMS: readonly TargetPlatform[] = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
] as const;

export const PROFILE_NAMES = ["safe", "standard", "full", "enterprise"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number] | string;

export type PermissionCategory =
  | "filesystem.read"
  | "filesystem.write"
  | "shell.execution"
  | "network.access"
  | "secrets.env"
  | "mcp.server"
  | "external_api.access"
  | "browser.access"
  | "repo.modification"
  | "git.operations"
  | "package.installation"
  | "user_data.access"
  | "private_context.access"
  | "model_provider_key.access";

export interface AgentPackMetadata {
  id: string;
  name: string;
  slug: string;
  description: string;
  version: string;
  license?: string;
  publisher: string;
  authors?: Array<{ name: string; email?: string; url?: string }>;
  tags?: string[];
  homepage?: string;
  repository?: string;
}

export interface CompatibilityTarget {
  status: CompatibilityStatus;
  notes?: string;
  minVersion?: string;
}

export type CompatibilityMap = Partial<Record<TargetPlatform, CompatibilityTarget>>;

export interface CompatibilityBlock {
  targets: CompatibilityMap;
}

export interface PermissionsBlock {
  filesystem?: {
    read?: string[];
    write?: string[];
  };
  shell?: {
    execution?: "required" | "optional" | "forbidden";
    commands?: string[];
  };
  network?: {
    access?: "required" | "optional" | "forbidden";
    domains?: string[];
  };
  secrets?: {
    required?: Array<{
      name: string;
      description?: string;
      required_for?: string[];
    }>;
  };
  mcp?: {
    servers?: string[];
  };
  external_apis?: string[];
  browser_access?: boolean;
  repo_modification?: boolean;
  git_operations?: string[];
  package_installation?: boolean;
  user_data_access?: boolean;
  private_context_access?: boolean;
  model_provider_key_access?: boolean;
}

export interface SecurityBlock {
  risk_level?: RiskLevel;
  risk_summary?: string;
  requires_review?: boolean;
  signed?: boolean;
  sandbox_recommended?: boolean;
  checksums?: { enabled?: boolean; file?: string };
  provenance?: { enabled?: boolean; file?: string };
}

export interface ProfileSpec {
  description?: string;
  include?: string[];
  exclude?: string[];
  policy?: Record<string, unknown>;
}

export interface DependenciesBlock {
  tools?: Array<{ name: string; required?: boolean; version?: string }>;
  packs?: Array<{ id: string; version?: string; optional?: boolean }>;
  mcp_servers?: Array<{
    id: string;
    package?: string;
    version?: string;
    optional?: boolean;
  }>;
}

export interface AtomBase {
  id: string;
  type: AtomType;
  name: string;
  description: string;
  path: string;
  risk_level: RiskLevel;
  permissions?: string[];
  platforms?: Partial<Record<TargetPlatform, CompatibilityStatus>>;
}

export interface CommandAtom extends AtomBase {
  type: "command";
  invocation?: { slash?: string; cli?: string };
}

export interface HookAtom extends AtomBase {
  type: "hook";
  lifecycle?: {
    events?: Partial<Record<TargetPlatform | "generic", string[]>>;
  };
}

export interface McpAtom extends AtomBase {
  type: "mcp_server";
  transport?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, { required?: boolean; description?: string } | string>;
}

export interface SkillAtom extends AtomBase {
  type: "skill";
  skill_format?: string;
}

export interface RuleAtom extends AtomBase {
  type: "rule";
  scope?: { file_globs?: string[] };
}

export type Atom =
  | (AtomBase & {
      type: Exclude<AtomType, "command" | "hook" | "mcp_server" | "skill" | "rule">;
    })
  | CommandAtom
  | HookAtom
  | McpAtom
  | SkillAtom
  | RuleAtom;

export interface ExportsBlock {
  default_profile?: ProfileName;
  output_dir?: string;
  lockfile?: string;
  include_readme?: boolean;
}

export interface AdaptersBlock {
  [target: string]: {
    enabled?: boolean;
    experimental?: boolean;
    output?: Record<string, string>;
  };
}

export interface AgentPackManifest {
  agentpack: string;
  metadata: AgentPackMetadata;
  compatibility: CompatibilityBlock;
  permissions?: PermissionsBlock;
  security?: SecurityBlock;
  profiles: Record<string, ProfileSpec>;
  dependencies?: DependenciesBlock;
  atoms: Atom[];
  exports?: ExportsBlock;
  adapters?: AdaptersBlock;
}

export interface LoadedManifest {
  manifest: AgentPackManifest;
  manifestPath: string;
  packRoot: string;
  rawYaml: string;
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ResolvedAtom {
  atom: Atom;
  reason: "include" | "wildcard" | "default";
  source: string;
}

export interface PermissionSummaryEntry {
  category: PermissionCategory | string;
  description: string;
  riskLevel: RiskLevel;
  atomIds: string[];
}

export interface PermissionSummary {
  byCategory: Record<string, PermissionSummaryEntry>;
  flat: PermissionSummaryEntry[];
  secrets: Array<{
    name: string;
    description?: string;
    requiredFor: string[];
  }>;
  domains: string[];
  shellCommands: string[];
}

export interface RiskSummary {
  level: RiskLevel;
  reasons: string[];
  atomRiskCounts: Record<RiskLevel, number>;
}

export interface AdapterOutputFile {
  path: string;
  content: string;
  action: "create" | "modify";
  notes?: string[];
  /**
   * Stamped by `defineAdapter` from the adapter's REQUIRED `execSurfaces`
   * declaration: true when the target runtime EXECUTES directives embedded
   * in this file's content — e.g. Claude Code runs `!`…`` (bang-bash) lines
   * in `.claude/commands/*.md` / `.claude/agents/*.md` bodies as shell the
   * moment the user invokes the command/agent. The install-time exec-consent
   * gate content-scans exactly the files marked true (#119); because the
   * flag rides the file object, it survives path remapping (e.g. `--scope
   * user`'s `.claude/X` → `X`) where a path regex would silently detach.
   * Outputs the runtime merely READS as instructions (CLAUDE.md, AGENTS.md,
   * skills, config JSON) are stamped false. Optional in the type only because
   * hand-built AdapterOutputFile literals predate it; every adapter built via
   * `defineAdapter` emits it explicitly.
   */
  execCapable?: boolean;
}

export interface AdapterExportOptions {
  manifest: AgentPackManifest;
  packRoot: string;
  resolvedAtoms: ResolvedAtom[];
  profile: string;
  target: TargetPlatform;
}

export interface AdapterResult {
  target: TargetPlatform;
  files: AdapterOutputFile[];
  warnings: string[];
  unsupportedAtoms: string[];
}

export interface AgentPackAdapter {
  target: TargetPlatform;
  export(options: AdapterExportOptions): Promise<AdapterResult>;
}

export interface InstallPlan {
  packId: string;
  packVersion: string;
  target: TargetPlatform;
  profile: string;
  atoms: string[];
  /**
   * Resolved atoms with their declared `type`. Unlike `atoms` (ids only) and the
   * lockfile's atom grouping (which collapses to a synthetic `*pack` entry when
   * output files can't be mapped to atoms), this is the authoritative typed list
   * of what the profile actually pulls in. Security gates that key off atom type
   * — e.g. the executable-surface gate (hook / mcp_server) — MUST use this
   * rather than parsing the `<type>:<slug>` id prefix, which an atom can set
   * independently of its real `type`.
   */
  atomTypes: Array<{ id: string; type: AtomType }>;
  riskLevel: RiskLevel;
  permissions: PermissionSummary;
  warnings: string[];
  files: AdapterOutputFile[];
  unsupportedAtoms: string[];
}
