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
};

/**
 * Compute the overall risk level for an installed pack profile. Risk is the
 * max() over: declared atom risk_levels, atom permissions, and certain
 * pack-level signals. Reasons are accumulated for human-readable display.
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
    if (RISK_ORDER[r.atom.risk_level] > RISK_ORDER[level]) {
      level = r.atom.risk_level;
      reasons.push(
        `Atom \`${r.atom.id}\` declares risk_level: ${r.atom.risk_level}`,
      );
    }
    for (const cat of r.atom.permissions ?? []) {
      const esc = ESCALATING_PERMISSIONS[cat];
      if (esc && RISK_ORDER[esc] > RISK_ORDER[level]) {
        level = esc;
        reasons.push(
          `Permission \`${cat}\` requested by \`${r.atom.id}\` raises risk to ${esc}`,
        );
      }
    }
    if (r.atom.type === "hook") {
      if (RISK_ORDER["high"] > RISK_ORDER[level]) level = "high";
      reasons.push(`Hook atom \`${r.atom.id}\` — hooks are high risk by policy`);
    }
    if (r.atom.type === "mcp_server") {
      const env = (r.atom as { env?: Record<string, unknown> }).env;
      if (env && Object.keys(env).length > 0) {
        if (RISK_ORDER["high"] > RISK_ORDER[level]) level = "high";
        reasons.push(
          `MCP server \`${r.atom.id}\` requires secrets/env (${Object.keys(env).join(", ")})`,
        );
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
    reasons.push(
      "Pack declares `permissions.model_provider_key_access: true` (critical)",
    );
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
