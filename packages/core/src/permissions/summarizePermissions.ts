import type {
  AgentPackManifest,
  PermissionCategory,
  PermissionSummary,
  PermissionSummaryEntry,
  ResolvedAtom,
  RiskLevel,
} from "../schema/types.js";

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

function describe(category: string): { label: string; risk: RiskLevel } {
  return (
    PERMISSION_DESCRIPTIONS[category] ?? {
      label: category,
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
 * Atom-type implicit permissions:
 *  - `hook` atom always implies `shell.execution` + `filesystem.write`.
 *  - `mcp_server` atom with `env` always implies `secrets.env` and (when
 *    declared) `network.access` + `external_api.access`.
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
      const a = r.atom as { env?: Record<string, unknown> };
      if (a.env && Object.keys(a.env).length > 0) {
        ensure("secrets.env", r.atom.id);
      }
      ensure("mcp.server", r.atom.id);
    }
  }

  // Pack-level signals that are conditional on which atoms made it in:
  const perms = manifest.permissions ?? {};

  // Network domains / external_apis — only surface when an atom needing
  // network is actually included.
  const networkConsumers = resolved.filter(
    (r) =>
      (r.atom.permissions ?? []).some(
        (p) => p === "network.access" || p === "external_api.access",
      ) || r.atom.type === "mcp_server",
  );
  const domains = networkConsumers.length > 0 ? perms.network?.domains ?? [] : [];
  const externalApis = networkConsumers.length > 0 ? perms.external_apis ?? [] : [];
  if (networkConsumers.length > 0) {
    if (domains.length > 0 || perms.network?.access === "required") {
      ensure("network.access");
    }
    if (externalApis.length > 0) ensure("external_api.access");
  }

  // Shell commands — only surface if any active atom uses shell.execution.
  const hasShellAtom = resolved.some(
    (r) =>
      r.atom.type === "hook" ||
      (r.atom.permissions ?? []).includes("shell.execution"),
  );
  const shellCommands = hasShellAtom ? perms.shell?.commands ?? [] : [];

  // Repo modification — only if an atom needs it.
  if (
    perms.repo_modification &&
    resolved.some((r) =>
      (r.atom.permissions ?? []).includes("repo.modification"),
    )
  ) {
    ensure("repo.modification");
  }
  if (
    perms.package_installation &&
    resolved.some((r) =>
      (r.atom.permissions ?? []).includes("package.installation"),
    )
  ) {
    ensure("package.installation");
  }
  if (
    perms.model_provider_key_access &&
    resolved.some((r) =>
      (r.atom.permissions ?? []).includes("model_provider_key.access"),
    )
  ) {
    ensure("model_provider_key.access");
  }
  if (
    perms.browser_access &&
    resolved.some((r) =>
      (r.atom.permissions ?? []).includes("browser.access"),
    )
  ) {
    ensure("browser.access");
  }
  if (perms.git_operations?.length) {
    // git ops are read-only and harmless; surface whenever at least one atom
    // requests git.operations (e.g. command:pr-summary).
    if (
      resolved.some((r) =>
        (r.atom.permissions ?? []).includes("git.operations"),
      )
    ) {
      ensure("git.operations");
    }
  }

  // Filesystem read/write hint from pack-level only if some atom actually
  // declares the permission OR is of a writing type (hook).
  if (perms.filesystem?.read?.length) {
    if (
      resolved.some((r) =>
        (r.atom.permissions ?? []).includes("filesystem.read"),
      )
    ) {
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
    flat: Object.values(byCategory).sort((a, b) =>
      a.category.localeCompare(b.category),
    ),
    secrets,
    domains,
    shellCommands,
  };
}
