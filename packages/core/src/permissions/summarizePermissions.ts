import type {
  AgentPackManifest,
  PermissionCategory,
  PermissionSummary,
  PermissionSummaryEntry,
  ResolvedAtom,
  RiskLevel,
} from "../schema/types.js";
import { isShellEscape } from "../adapters/commandGate.js";

const PERMISSION_DESCRIPTIONS: Record<string, { label: string; risk: RiskLevel }> = {
  "filesystem.read": { label: "Read files in the project", risk: "low" },
  "filesystem.write": { label: "Write or modify files in the project", risk: "high" },
  "shell.execution": { label: "Run shell commands on your machine", risk: "high" },
  "network.access": { label: "Make outbound network requests", risk: "medium" },
  "secrets.env": { label: "Read environment variables / secrets", risk: "high" },
  "mcp.server": { label: "Run or configure an MCP server", risk: "high" },
  "external_api.access": { label: "Call an external HTTP API", risk: "medium" },
  "browser.access": { label: "Drive a browser session", risk: "high" },
  "repo.modification": { label: "Modify repository contents", risk: "high" },
  "git.operations": { label: "Run git read operations (status/diff/log)", risk: "low" },
  "package.installation": { label: "Install npm/system packages", risk: "critical" },
  "user_data.access": { label: "Access user-private data", risk: "high" },
  "private_context.access": { label: "Access private context packs", risk: "medium" },
  "model_provider_key.access": { label: "Use model provider API keys", risk: "critical" },
};

export const KNOWN_PERMISSION_CATEGORIES: ReadonlyArray<string> = Object.freeze(
  Object.keys(PERMISSION_DESCRIPTIONS),
);

function describe(category: string): { label: string; risk: RiskLevel } {
  return (
    PERMISSION_DESCRIPTIONS[category] ?? {
      label: `${category} (unknown category)`,
      risk: "medium" as RiskLevel,
    }
  );
}

/**
 * Compute a categorized, human-readable permission summary for the given
 * resolved atom subset.
 *
 * **Active surface is atom-driven.** Pack-level `permissions:` declarations
 * describe the *full possible* surface across the pack (used in the registry
 * UI and inspect view); the *active* surface for any given profile is
 * determined by which atoms are actually included.
 *
 * Atom-type implicit permissions (cannot be hidden by omitting `permissions:`):
 *  - `hook` atom always implies `shell.execution` + `filesystem.write`.
 *  - `mcp_server` atom always implies `mcp.server` (hard implication of
 *    out-of-process code), `secrets.env` when `env:` is present, and
 *    `shell.execution` when the command looks like a shell escape
 *    (`sh`/`bash`/`node`/`python` invoked with `-c`/`-e`/`--eval`).
 *  - `command` / `skill` / `subagent` / `workflow` atoms always imply
 *    `filesystem.read` (their body file is read into the agent's context).
 *  - `package` install / model-provider-key access on the pack-level block
 *    is always surfaced when declared (these are big-deal categories).
 */
export function summarizePermissions(
  manifest: AgentPackManifest,
  resolved: ResolvedAtom[],
): PermissionSummary {
  const byCategory: Record<string, PermissionSummaryEntry> = {};
  const includedAtomIds = new Set(resolved.map((r) => r.atom.id));

  const ensure = (cat: string, attribAtomId?: string): PermissionSummaryEntry => {
    let entry = byCategory[cat];
    if (!entry) {
      const { label, risk } = describe(cat);
      entry = {
        category: cat as PermissionCategory,
        description: label,
        riskLevel: risk,
        atomIds: [],
      };
      byCategory[cat] = entry;
    }
    if (attribAtomId && !entry.atomIds.includes(attribAtomId)) {
      entry.atomIds.push(attribAtomId);
    }
    return entry;
  };

  for (const r of resolved) {
    for (const cat of r.atom.permissions ?? []) ensure(cat, r.atom.id);

    if (r.atom.type === "hook") {
      ensure("shell.execution", r.atom.id);
      ensure("filesystem.write", r.atom.id);
    }
    if (r.atom.type === "mcp_server") {
      ensure("mcp.server", r.atom.id);
      const a = r.atom as {
        env?: Record<string, unknown>;
        command?: string;
        args?: string[];
      };
      if (a.env && Object.keys(a.env).length > 0) {
        ensure("secrets.env", r.atom.id);
      }
      if (a.command && isShellEscape(a.command, a.args ?? [])) {
        ensure("shell.execution", r.atom.id);
      }
    }
    if (
      r.atom.type === "command" ||
      r.atom.type === "skill" ||
      r.atom.type === "subagent" ||
      r.atom.type === "workflow"
    ) {
      ensure("filesystem.read", r.atom.id);
    }
  }

  // Pack-level signals that are conditional on which atoms made it in:
  const perms = manifest.permissions ?? {};

  const networkConsumers = resolved.filter(
    (r) =>
      (r.atom.permissions ?? []).some(
        (p) => p === "network.access" || p === "external_api.access",
      ) || r.atom.type === "mcp_server",
  );
  const domains = networkConsumers.length > 0 ? (perms.network?.domains ?? []) : [];
  const externalApis = networkConsumers.length > 0 ? (perms.external_apis ?? []) : [];
  if (networkConsumers.length > 0) {
    if (domains.length > 0 || perms.network?.access === "required") {
      ensure("network.access");
    }
    if (externalApis.length > 0) ensure("external_api.access");
  }

  const hasShellAtom = resolved.some(
    (r) => r.atom.type === "hook" || (r.atom.permissions ?? []).includes("shell.execution"),
  );
  const shellCommands = hasShellAtom ? (perms.shell?.commands ?? []) : [];

  if (
    perms.repo_modification &&
    resolved.some((r) => (r.atom.permissions ?? []).includes("repo.modification"))
  ) {
    ensure("repo.modification");
  }

  // High-impact pack-level flags — always surface when declared, regardless
  // of which atom backs them. These are big-deal categories (#3 from agent
  // review: previously user_data_access and private_context_access were
  // silently dropped).
  if (perms.package_installation) ensure("package.installation");
  if (perms.model_provider_key_access) ensure("model_provider_key.access");
  if (perms.user_data_access) ensure("user_data.access");
  if (perms.private_context_access) ensure("private_context.access");
  if (perms.browser_access) ensure("browser.access");
  if (perms.git_operations?.length) {
    if (resolved.some((r) => (r.atom.permissions ?? []).includes("git.operations"))) {
      ensure("git.operations");
    }
  }

  if (perms.filesystem?.read?.length) {
    if (resolved.some((r) => (r.atom.permissions ?? []).includes("filesystem.read"))) {
      ensure("filesystem.read");
    }
  }

  // Secrets — only the ones required for atoms that are included in the plan.
  const secrets = (perms.secrets?.required ?? [])
    .filter((s) => {
      if (!s.required_for || s.required_for.length === 0) {
        // No targeting → consider it always-on.
        return true;
      }
      return s.required_for.some((aid) => {
        if (aid.includes("*")) {
          const [prefix, suffix = ""] = aid.split("*", 2) as [string, string?];
          return [...includedAtomIds].some(
            (id) => id.startsWith(prefix ?? "") && id.endsWith(suffix ?? ""),
          );
        }
        return includedAtomIds.has(aid);
      });
    })
    .map((s) => ({
      name: s.name,
      description: s.description,
      requiredFor: s.required_for ?? [],
    }));

  if (secrets.length > 0) ensure("secrets.env");

  return {
    byCategory,
    flat: Object.values(byCategory).sort((a, b) => a.category.localeCompare(b.category)),
    secrets,
    domains,
    shellCommands,
  };
}
