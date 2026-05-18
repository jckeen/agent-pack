import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeRisk,
  loadManifest,
  resolveAtoms,
  summarizePermissions,
} from "../src/index.js";

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");

describe("risk + permissions", () => {
  it("safe profile excludes hooks and MCP servers", async () => {
    const { manifest } = await loadManifest(EXAMPLE);
    const resolved = resolveAtoms({ manifest, profile: "safe" });
    const ids = resolved.map((r) => r.atom.id);
    expect(ids).not.toContain("hook:post-edit-format");
    expect(ids).not.toContain("mcp_server:github");
  });

  it("safe profile produces LOW overall risk", async () => {
    const { manifest } = await loadManifest(EXAMPLE);
    const resolved = resolveAtoms({ manifest, profile: "safe" });
    const perms = summarizePermissions(manifest, resolved);
    const risk = computeRisk(manifest, resolved, perms);
    expect(risk.level).toBe("low");
  });

  it("full profile pulls in hooks and MCP server and escalates risk", async () => {
    const { manifest } = await loadManifest(EXAMPLE);
    const resolved = resolveAtoms({ manifest, profile: "full" });
    const ids = resolved.map((r) => r.atom.id);
    expect(ids).toContain("hook:post-edit-format");
    expect(ids).toContain("mcp_server:github");
    const perms = summarizePermissions(manifest, resolved);
    const risk = computeRisk(manifest, resolved, perms);
    // The PR-Quality full profile combines shell + secrets + network +
    // filesystem.write — that's the critical-combo by the spec's own rule.
    expect(["high", "critical"]).toContain(risk.level);
  });

  it("hook atoms always classify as high risk", async () => {
    const { manifest } = await loadManifest(EXAMPLE);
    const hookAtom = manifest.atoms.find((a) => a.type === "hook");
    expect(hookAtom?.risk_level).toBe("high");
  });

  it("permission summary surfaces shell.execution and secrets.env for full profile", async () => {
    const { manifest } = await loadManifest(EXAMPLE);
    const resolved = resolveAtoms({ manifest, profile: "full" });
    const perms = summarizePermissions(manifest, resolved);
    expect(perms.byCategory).toHaveProperty("shell.execution");
    expect(perms.byCategory).toHaveProperty("secrets.env");
    expect(perms.byCategory).toHaveProperty("mcp.server");
    expect(perms.secrets.some((s) => s.name === "GITHUB_TOKEN")).toBe(true);
  });

  it("safe profile permission summary contains no shell.execution and no secrets", async () => {
    const { manifest } = await loadManifest(EXAMPLE);
    const resolved = resolveAtoms({ manifest, profile: "safe" });
    const perms = summarizePermissions(manifest, resolved);
    expect(perms.byCategory).not.toHaveProperty("shell.execution");
    expect(perms.byCategory).not.toHaveProperty("secrets.env");
    expect(perms.secrets).toEqual([]);
  });

  it("risk is monotonically non-decreasing as profile widens", async () => {
    const { manifest } = await loadManifest(EXAMPLE);
    const order: Record<string, number> = {
      low: 0,
      medium: 1,
      high: 2,
      critical: 3,
    };
    const riskFor = (profile: string) => {
      const resolved = resolveAtoms({ manifest, profile });
      const perms = summarizePermissions(manifest, resolved);
      return computeRisk(manifest, resolved, perms).level;
    };
    expect(order[riskFor("standard")]).toBeGreaterThanOrEqual(order[riskFor("safe")]!);
    expect(order[riskFor("full")]).toBeGreaterThanOrEqual(order[riskFor("standard")]!);
  });
});
