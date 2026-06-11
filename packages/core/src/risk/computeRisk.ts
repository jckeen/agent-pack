import type {
  AgentPackManifest,
  PermissionSummary,
  ResolvedAtom,
  RiskLevel,
  RiskSummary,
} from "../schema/types.js";

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

const ESCALATING_PERMISSIONS: Record<string, RiskLevel> = {
  "shell.execution": "high",
  "package.installation": "critical",
  "model_provider_key.access": "critical",
  "secrets.env": "high",
  "browser.access": "high",
  "user_data.access": "high",
  "repo.modification": "high",
  "external_api.access": "medium",
  "network.access": "medium",
  "filesystem.write": "high",
};

/**
 * Atom-type floors. Some atom types have an effect that's unavoidable
 * regardless of author-declared `risk_level`:
 *
 * - `hook` always floors at `high` — executes a shell command after agent
 *   edits, full stop.
 * - `mcp_server` always floors at `high` — runs an out-of-process server with
 *   bidirectional message access; even a "harmless" MCP has process exec.
 * - `plugin` floors at `medium` — third-party code surface.
 *
 * `instruction` / `rule` / `template` / `eval` / `skill` / `command` /
 * `subagent` / `workflow` / `context_pack` stay at author-declared
 * `risk_level`. They host LLM-readable content; if a pack author wants to
 * declare them `low`, that's an author attestation. The permission engine
 * and explicit `permissions: [...]` arrays escalate further when the atom
 * actually requests dangerous capability.
 */
const ATOM_TYPE_RISK_FLOORS: Record<string, RiskLevel> = {
  hook: "high",
  mcp_server: "high",
  plugin: "medium",
};

/**
 * Patterns whose presence in an MCP server `command` / `args` indicate the
 * server is just a shell escape — these are treated as `critical`.
 */
const MCP_SHELL_SHAPES = /^(sh|bash|zsh|dash|fish|node|python(?:3)?|ruby|perl|deno|bun)$/i;
const MCP_SHELL_FLAGS = /^-c$|^-e$|^--eval$|^--command$/i;

/**
 * Compute the overall risk level for an installed pack profile.
 *
 * The result is the **max** over:
 *  - Each included atom's declared `risk_level`.
 *  - Per-atom-type floors (`hook` → high, `mcp_server` → high, etc.).
 *  - Per-permission escalations (`shell.execution` → high, `package.installation` → critical).
 *  - Atom-type-implicit signals (mcp with env → secrets/high; mcp with shell-shape command → critical).
 *  - Pack-level signals (`package_installation`, `model_provider_key_access`).
 *  - The combo `shell + secrets + network + filesystem.write` → critical.
 *
 * Reasons are accumulated for every atom and every escalating permission so
 * the audit trail is complete — not just deltas that bumped the level.
 */
export function computeRisk(
  manifest: AgentPackManifest,
  resolved: ResolvedAtom[],
  permissionSummary?: PermissionSummary,
): RiskSummary {
  const reasons: string[] = [];
  const atomRiskCounts: Record<RiskLevel, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  let level: RiskLevel = "low";

  for (const r of resolved) {
    atomRiskCounts[r.atom.risk_level]++;
    // Log atom risk for medium+ atoms. A "declares risk_level: low" line for
    // every atom rendered as a ⚠ warning trains consumers (especially
    // agents told to react to warnings) to ignore the warning channel; the
    // full per-atom audit trail lives in atomRiskCounts + the manifest.
    if (r.atom.risk_level !== "low") {
      reasons.push(`Atom \`${r.atom.id}\` declares risk_level: ${r.atom.risk_level}`);
    }
    level = maxRisk(level, r.atom.risk_level);

    // Atom-type floors (hook/mcp/command/skill/subagent/workflow).
    const typeFloor = ATOM_TYPE_RISK_FLOORS[r.atom.type];
    if (typeFloor && RISK_ORDER[typeFloor] > RISK_ORDER[r.atom.risk_level]) {
      reasons.push(
        `Atom type \`${r.atom.type}\` floors risk at \`${typeFloor}\` (atom \`${r.atom.id}\`)`,
      );
      level = maxRisk(level, typeFloor);
    }

    // Permission-based escalations.
    for (const cat of r.atom.permissions ?? []) {
      const esc = ESCALATING_PERMISSIONS[cat];
      if (esc) {
        reasons.push(`Permission \`${cat}\` requested by \`${r.atom.id}\` (${esc})`);
        level = maxRisk(level, esc);
      }
    }

    // MCP server specifics.
    if (r.atom.type === "mcp_server") {
      const a = r.atom as {
        env?: Record<string, unknown>;
        command?: string;
        args?: string[];
      };
      if (a.env && Object.keys(a.env).length > 0) {
        reasons.push(
          `MCP server \`${r.atom.id}\` requires secrets (${Object.keys(a.env).join(", ")})`,
        );
        level = maxRisk(level, "high");
      }
      // mcp_server invoking a generic shell with -c / -e is a shell escape.
      const cmdBase = (a.command ?? "").split(/[\\/]/).pop() ?? "";
      const looksShell = MCP_SHELL_SHAPES.test(cmdBase);
      const hasEvalFlag = (a.args ?? []).some((arg) => MCP_SHELL_FLAGS.test(arg));
      if (looksShell && hasEvalFlag) {
        reasons.push(
          `MCP server \`${r.atom.id}\` invokes \`${cmdBase}\` with an eval flag — treated as shell escape (critical)`,
        );
        level = maxRisk(level, "critical");
      }
    }
  }

  // Pack-level package_installation → critical.
  if (manifest.permissions?.package_installation) {
    level = maxRisk(level, "critical");
    reasons.push("Pack declares `permissions.package_installation: true` (critical)");
  }
  if (manifest.permissions?.model_provider_key_access) {
    level = maxRisk(level, "critical");
    reasons.push("Pack declares `permissions.model_provider_key_access: true` (critical)");
  }

  // Combo: shell + secrets + network + filesystem write → critical.
  if (permissionSummary) {
    const cats = new Set(Object.keys(permissionSummary.byCategory));
    if (
      cats.has("shell.execution") &&
      cats.has("secrets.env") &&
      cats.has("network.access") &&
      cats.has("filesystem.write")
    ) {
      level = maxRisk(level, "critical");
      reasons.push(
        "Critical permission combo: shell + secrets + network + filesystem.write",
      );
    }
  }

  return { level, reasons, atomRiskCounts };
}
