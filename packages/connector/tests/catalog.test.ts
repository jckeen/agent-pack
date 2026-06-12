import { describe, it, expect } from "vitest";
import * as path from "node:path";

import { loadPackCatalog, atomSlug, buildMcpServer } from "../src/index.js";

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");

describe("atomSlug", () => {
  it("strips the type prefix and kebab-cases", () => {
    expect(atomSlug("skill:code-review")).toBe("code-review");
    expect(atomSlug("instruction:pr-review-standards")).toBe("pr-review-standards");
    expect(atomSlug("mcp_server:github")).toBe("github");
    expect(atomSlug("Command:PR Summary")).toBe("pr-summary");
  });
});

describe("loadPackCatalog", () => {
  it("turns skills/commands/instructions/rules into prompts + resources", async () => {
    const catalog = await loadPackCatalog(EXAMPLE);
    expect(catalog.packId).toBe("agentpack.pr-quality");
    expect(catalog.packSlug).toBe("pr-quality");

    const promptNames = catalog.prompts.map((p) => p.name);
    // The example pack's carried atoms.
    expect(promptNames).toContain("code-review");
    expect(promptNames).toContain("pr-summary");
    expect(promptNames).toContain("pr-review-standards");
    // Every prompt carries non-empty guidance text.
    for (const p of catalog.prompts) {
      expect(p.body.length).toBeGreaterThan(0);
    }
    // Resources exist and use the agentpack:// scheme.
    expect(catalog.resources.length).toBeGreaterThan(0);
    for (const r of catalog.resources) {
      expect(r.uri.startsWith("agentpack://pr-quality/")).toBe(true);
    }
  });

  it("excludes hooks and mcp_servers with a reason", async () => {
    const catalog = await loadPackCatalog(EXAMPLE);
    const excludedTypes = catalog.excluded.map((e) => e.type);
    // pr-quality has a hook and an mcp_server atom — neither is carried.
    expect(excludedTypes).toContain("hook");
    expect(excludedTypes).toContain("mcp_server");
    expect(catalog.prompts.some((p) => p.atomType === "hook")).toBe(false);
    for (const e of catalog.excluded) {
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("buildMcpServer", () => {
  it("constructs a server from the catalog without throwing", async () => {
    const catalog = await loadPackCatalog(EXAMPLE);
    // Registration of every prompt/resource/tool must succeed (no duplicate
    // names, valid configs). The SDK throws on registration errors.
    const server = buildMcpServer(catalog);
    expect(server).toBeDefined();
  });
});
