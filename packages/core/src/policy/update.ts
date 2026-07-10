/**
 * Sync S2 (#111): policy enforcement for `agentpack update` — channel
 * ceiling, exec re-consent, and risk-escalation gates (docs/sync-design.md §4).
 *
 * Every input here must be FRESHLY derived at update time (live channel from
 * the re-fetch, exec delta from the reconciled write set, risk from the new
 * plan) — never read back from the stored source block, which a tampered
 * manifest controls (security note on #111).
 */

import type { RiskLevel } from "../schema/types.js";
import type { PolicyConfig } from "./schema.js";

export interface UpdatePolicyPlan {
  /** Live-derived channel of the source being updated. */
  channel: "pinned" | "tag" | "branch" | "latest";
  /** Exec-bearing delta: added hook/mcp_server atoms or exec-surface writes. */
  execDelta: boolean;
  /** Any file written or removed by this update. */
  anyDelta: boolean;
  /** --allow-exec passed on this invocation. */
  allowExec: boolean;
  /** Signature verified for THIS new version (registry --require-sig path). */
  signatureVerified: boolean;
  /** Risk recorded at install time; absent on pre-S2 manifests. */
  installedRisk?: RiskLevel | undefined;
  /** Computed risk of the new plan. */
  newRisk: RiskLevel;
}

export interface UpdatePolicyViolation {
  code: "channel" | "reconsent" | "riskEscalation";
  message: string;
  hint?: string;
}

export type UpdatePolicyResult =
  | { ok: true; warnings: string[] }
  | { ok: false; violations: UpdatePolicyViolation[]; warnings: string[] };

const CHANNEL_RANK: Record<UpdatePolicyPlan["channel"], number> = {
  pinned: 0,
  tag: 1,
  branch: 2,
  // A registry `latest` channel moves whenever a new version publishes —
  // as loose as tracking a branch.
  latest: 2,
};

const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function enforceUpdatePolicy(
  policy: PolicyConfig | null,
  plan: UpdatePolicyPlan,
): UpdatePolicyResult {
  const violations: UpdatePolicyViolation[] = [];
  const warnings: string[] = [];
  const update = policy?.update ?? {};

  // 1. Channel ceiling.
  if (update.channel !== undefined) {
    if (CHANNEL_RANK[plan.channel] > CHANNEL_RANK[update.channel]) {
      violations.push({
        code: "channel",
        message: `update channel \`${plan.channel}\` exceeds the policy ceiling \`${update.channel}\``,
        hint: "re-install pinned to a SHA or tag, or raise update.channel in agentpack.policy.json",
      });
    }
  }

  // 2. Re-consent. A cryptographically verified new version substitutes for
  // --allow-exec in every mode (same rule as install). For UNSIGNED updates
  // the exec floor never lowers: an exec-bearing delta always needs
  // --allow-exec, whatever requireReconsent says — "never" only widens the
  // signature path, and "always" extends consent to non-exec deltas.
  if (!plan.signatureVerified) {
    const mode = update.requireReconsent ?? "exec";
    const execNeedsConsent = plan.execDelta && !plan.allowExec;
    const anyNeedsConsent = mode === "always" && plan.anyDelta && !plan.allowExec;
    if (execNeedsConsent || anyNeedsConsent) {
      violations.push({
        code: "reconsent",
        message: execNeedsConsent
          ? "this update changes executable content (hooks / MCP servers / bang-bash commands) and is not signature-verified"
          : "policy update.requireReconsent is `always` and this update is not signature-verified",
        hint: "re-run with --allow-exec (intentionally separate from --yes), or update from a signed registry version with --require-sig",
      });
    }
  }

  // 3. Risk escalation.
  const maxEscalation = update.maxRiskEscalation ?? "any";
  if (maxEscalation !== "any") {
    if (plan.installedRisk === undefined) {
      warnings.push(
        "policy update.maxRiskEscalation is set but the installed version predates risk recording — escalation gate skipped for this update (it applies from the next one)",
      );
    } else {
      const allowed = maxEscalation === "none" ? 0 : 1;
      if (RISK_RANK[plan.newRisk] - RISK_RANK[plan.installedRisk] > allowed) {
        violations.push({
          code: "riskEscalation",
          message: `new version risk \`${plan.newRisk}\` exceeds installed \`${plan.installedRisk}\` by more than policy allows (${maxEscalation})`,
          hint: "review the new version's permissions, then raise update.maxRiskEscalation or re-install explicitly",
        });
      }
    }
  }

  if (violations.length > 0) return { ok: false, violations, warnings };
  return { ok: true, warnings };
}
