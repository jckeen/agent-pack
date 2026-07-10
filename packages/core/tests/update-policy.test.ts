// Sync S2 (#111): the policy `update` section — channel ceiling, exec
// re-consent, and risk-escalation gates. Every gate keys off FRESHLY derived
// facts (channel, exec delta, new risk), never the stored source block
// (see the security note on #111).
import { describe, it, expect } from "vitest";
import { policyConfigSchema } from "../src/policy/schema.js";
import { enforceUpdatePolicy } from "../src/policy/update.js";

function policyWith(update: Record<string, unknown>) {
  return policyConfigSchema.parse({ policyVersion: 1, update });
}

const BASE_PLAN = {
  channel: "branch" as const,
  execDelta: false,
  anyDelta: true,
  allowExec: false,
  signatureVerified: false,
  installedRisk: "low" as const,
  newRisk: "low" as const,
};

describe("policy schema — update section", () => {
  it("accepts the documented update fields", () => {
    const parsed = policyConfigSchema.safeParse({
      policyVersion: 1,
      update: {
        channel: "tag",
        requireReconsent: "always",
        maxRiskEscalation: "one-level",
      },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("rejects unknown channel values", () => {
    const parsed = policyConfigSchema.safeParse({
      policyVersion: 1,
      update: { channel: "nightly" },
    });
    expect(parsed.success).toBe(false);
  });

  it("stays optional — a policy without an update section parses", () => {
    const parsed = policyConfigSchema.safeParse({ policyVersion: 1 });
    expect(parsed.success).toBe(true);
  });
});

describe("enforceUpdatePolicy — channel ceiling", () => {
  it("refuses a branch-channel update under a pinned ceiling", () => {
    const r = enforceUpdatePolicy(policyWith({ channel: "pinned" }), BASE_PLAN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.map((v) => v.code)).toContain("channel");
  });

  it("allows a pinned update under a branch ceiling", () => {
    const r = enforceUpdatePolicy(policyWith({ channel: "branch" }), {
      ...BASE_PLAN,
      channel: "pinned",
    });
    expect(r.ok).toBe(true);
  });

  it("treats registry latest as loose as branch", () => {
    const r = enforceUpdatePolicy(policyWith({ channel: "tag" }), {
      ...BASE_PLAN,
      channel: "latest",
    });
    expect(r.ok).toBe(false);
  });

  it("no ceiling → any channel passes", () => {
    const r = enforceUpdatePolicy(policyWith({}), BASE_PLAN);
    expect(r.ok).toBe(true);
  });
});

describe("enforceUpdatePolicy — exec re-consent", () => {
  it("default (exec): an unsigned exec delta without --allow-exec is refused", () => {
    const r = enforceUpdatePolicy(null, { ...BASE_PLAN, execDelta: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.map((v) => v.code)).toContain("reconsent");
  });

  it("default (exec): --allow-exec satisfies the exec delta", () => {
    const r = enforceUpdatePolicy(null, {
      ...BASE_PLAN,
      execDelta: true,
      allowExec: true,
    });
    expect(r.ok).toBe(true);
  });

  it("default (exec): a signature-verified exec delta needs no flag", () => {
    const r = enforceUpdatePolicy(null, {
      ...BASE_PLAN,
      execDelta: true,
      signatureVerified: true,
    });
    expect(r.ok).toBe(true);
  });

  it("always: any unsigned delta requires --allow-exec", () => {
    const r = enforceUpdatePolicy(policyWith({ requireReconsent: "always" }), BASE_PLAN);
    expect(r.ok).toBe(false);
  });

  it("never: an UNSIGNED exec delta still requires --allow-exec (install-grade floor)", () => {
    const r = enforceUpdatePolicy(policyWith({ requireReconsent: "never" }), {
      ...BASE_PLAN,
      execDelta: true,
    });
    expect(r.ok).toBe(false);
  });

  it("a non-exec delta passes without flags under the default", () => {
    const r = enforceUpdatePolicy(null, BASE_PLAN);
    expect(r.ok).toBe(true);
  });
});

describe("enforceUpdatePolicy — risk escalation", () => {
  it("none: any risk increase is refused", () => {
    const r = enforceUpdatePolicy(policyWith({ maxRiskEscalation: "none" }), {
      ...BASE_PLAN,
      installedRisk: "low",
      newRisk: "medium",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.map((v) => v.code)).toContain("riskEscalation");
  });

  it("one-level: a single step is allowed, two steps refused", () => {
    const one = enforceUpdatePolicy(policyWith({ maxRiskEscalation: "one-level" }), {
      ...BASE_PLAN,
      installedRisk: "low",
      newRisk: "medium",
    });
    expect(one.ok).toBe(true);
    const two = enforceUpdatePolicy(policyWith({ maxRiskEscalation: "one-level" }), {
      ...BASE_PLAN,
      installedRisk: "low",
      newRisk: "high",
    });
    expect(two.ok).toBe(false);
  });

  it("unknown installed risk (pre-S2 manifest) warns instead of refusing", () => {
    const r = enforceUpdatePolicy(policyWith({ maxRiskEscalation: "none" }), {
      ...BASE_PLAN,
      installedRisk: undefined,
      newRisk: "critical",
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
