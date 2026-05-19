import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  enforcePolicy,
  loadPolicy,
  PolicyParseError,
  POLICY_VERSION,
  type PolicyConfig,
  type PolicyEnforcementPlan,
} from "../src/policy/index.js";

let tmpDir: string;
const projectRoot = () => tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wgpolicy-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writePolicy(content: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, "agentpack.policy.json"), content);
}

const basePlan: PolicyEnforcementPlan = {
  packId: "agentpack/pr-quality",
  publisher: "agentpack",
  pack: "pr-quality",
  target: "claude-code",
  profile: "safe",
  atomTypes: ["skill", "rule"],
  signed: false,
};

describe("loadPolicy", () => {
  it("returns null when file absent", async () => {
    expect(await loadPolicy(projectRoot())).toBeNull();
  });

  it("throws on invalid JSON", async () => {
    await writePolicy("{ not json");
    await expect(loadPolicy(projectRoot())).rejects.toBeInstanceOf(
      PolicyParseError
    );
  });

  it("throws on wrong policyVersion", async () => {
    await writePolicy(JSON.stringify({ policyVersion: 2 }));
    await expect(loadPolicy(projectRoot())).rejects.toBeInstanceOf(
      PolicyParseError
    );
  });

  it("parses a minimal valid policy", async () => {
    await writePolicy(JSON.stringify({ policyVersion: POLICY_VERSION }));
    const p = await loadPolicy(projectRoot());
    expect(p?.policyVersion).toBe(POLICY_VERSION);
  });
});

describe("enforcePolicy", () => {
  it("allows when policy null", () => {
    const res = enforcePolicy(null, basePlan, "https://registry.agentpack.dev");
    expect(res.ok).toBe(true);
  });

  it("blocks unsigned when requireSignature: true", () => {
    const policy: PolicyConfig = {
      policyVersion: POLICY_VERSION,
      registries: { allowed: [] },
      packs: {},
      install: { requireSignature: true },
      verify: {},
    };
    const res = enforcePolicy(
      policy,
      basePlan,
      "https://registry.agentpack.dev"
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.violations.find((v) => v.code === "unsigned")).toBeTruthy();
  });

  it("blocks disallowed profile", () => {
    const policy: PolicyConfig = {
      policyVersion: POLICY_VERSION,
      registries: { allowed: [] },
      packs: {},
      install: { allowedProfiles: ["safe"] },
      verify: {},
    };
    const res = enforcePolicy(
      policy,
      { ...basePlan, profile: "full" },
      "https://registry.agentpack.dev"
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.violations.find((v) => v.code === "profile")).toBeTruthy();
  });

  it("blocks denied atom types", () => {
    const policy: PolicyConfig = {
      policyVersion: POLICY_VERSION,
      registries: { allowed: [] },
      packs: {},
      install: { deniedAtomTypes: ["hook"] },
      verify: {},
    };
    const res = enforcePolicy(
      policy,
      { ...basePlan, atomTypes: ["skill", "hook"] },
      "https://registry.agentpack.dev"
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.violations.find((v) => v.code === "atomType")).toBeTruthy();
  });

  it("blocks unknown registry", () => {
    const policy: PolicyConfig = {
      policyVersion: POLICY_VERSION,
      registries: { allowed: ["https://internal.example.com"] },
      packs: {},
      install: {},
      verify: {},
    };
    const res = enforcePolicy(
      policy,
      basePlan,
      "https://registry.agentpack.dev"
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.violations.find((v) => v.code === "registry")).toBeTruthy();
  });

  it("blocks publisher not in allowlist", () => {
    const policy: PolicyConfig = {
      policyVersion: POLICY_VERSION,
      registries: { allowed: [] },
      packs: { allowedPublishers: ["acme"] },
      install: {},
      verify: {},
    };
    const res = enforcePolicy(
      policy,
      basePlan,
      "https://registry.agentpack.dev"
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.violations.find((v) => v.code === "publisher")).toBeTruthy();
  });

  it("blocks explicitly-blocked pack", () => {
    const policy: PolicyConfig = {
      policyVersion: POLICY_VERSION,
      registries: { allowed: [] },
      packs: { blockedPacks: ["agentpack/pr-quality"] },
      install: {},
      verify: {},
    };
    const res = enforcePolicy(
      policy,
      basePlan,
      "https://registry.agentpack.dev"
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.violations.find((v) => v.code === "blockedPack")).toBeTruthy();
  });

  it("reports multiple violations at once", () => {
    const policy: PolicyConfig = {
      policyVersion: POLICY_VERSION,
      registries: { allowed: ["https://internal.example.com"] },
      packs: { allowedPublishers: ["acme"] },
      install: { requireSignature: true, allowedProfiles: ["safe"] },
      verify: {},
    };
    const res = enforcePolicy(
      policy,
      { ...basePlan, profile: "full" },
      "https://registry.agentpack.dev"
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.violations.length).toBeGreaterThanOrEqual(4);
  });
});
