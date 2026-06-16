import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { exportPlugin } from "../src/exports/exportPlugin.js";
import { summarizePortability, portabilityFor } from "../src/portability.js";

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-plugin-"));
}

async function read(dir: string, rel: string): Promise<string> {
  return fs.readFile(path.join(dir, rel), "utf8");
}

async function exists(dir: string, rel: string): Promise<boolean> {
  return fs.stat(path.join(dir, rel)).then(
    () => true,
    () => false,
  );
}

describe("exportPlugin", () => {
  it("emits a valid Claude Code plugin layout for the full profile", async () => {
    const out = await tmp();
    const result = await exportPlugin({
      source: EXAMPLE,
      profile: "full",
      outDir: out,
      marketplace: true,
    });
    expect(result.pluginName).toBe("pr-quality");

    // plugin.json — required `name`, kebab-case, with metadata.
    const plugin = JSON.parse(await read(out, ".claude-plugin/plugin.json"));
    expect(plugin.name).toBe("pr-quality");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.description).toBeTruthy();
    expect(plugin.author?.name).toBe("AgentPack");

    // Components relocated to plugin root (NOT under .claude/).
    expect(await exists(out, "skills/code-review/SKILL.md")).toBe(true);
    expect(await exists(out, "commands/pr-summary.md")).toBe(true);
    expect(await exists(out, "agents/security-reviewer.md")).toBe(true);
    expect(await exists(out, ".mcp.json")).toBe(true);
    expect(await exists(out, ".claude/skills/code-review/SKILL.md")).toBe(false);

    // Hooks extracted into hooks/hooks.json under a `hooks` key.
    const hooks = JSON.parse(await read(out, "hooks/hooks.json"));
    expect(hooks.hooks.PostToolUse).toBeDefined();

    // Instruction/rule content bundled as an on-invoke guidance skill.
    const guidance = await read(out, "skills/pr-quality-guidance/SKILL.md");
    expect(guidance).toMatch(/^---\nname: pr-quality-guidance/);
    expect(guidance).toContain("ambient only in Claude Code");

    await fs.rm(out, { recursive: true, force: true });
  });

  it("emits a one-plugin marketplace.json when requested", async () => {
    const out = await tmp();
    await exportPlugin({
      source: EXAMPLE,
      profile: "full",
      outDir: out,
      marketplace: true,
    });
    const mkt = JSON.parse(await read(out, ".claude-plugin/marketplace.json"));
    expect(mkt.name).toBe("pr-quality-marketplace");
    expect(mkt.owner?.name).toBeTruthy();
    expect(mkt.plugins).toHaveLength(1);
    expect(mkt.plugins[0].name).toBe("pr-quality");
    expect(mkt.plugins[0].source).toBe(".");
    await fs.rm(out, { recursive: true, force: true });
  });

  it("omits marketplace.json when marketplace:false", async () => {
    const out = await tmp();
    await exportPlugin({
      source: EXAMPLE,
      profile: "full",
      outDir: out,
      marketplace: false,
    });
    expect(await exists(out, ".claude-plugin/marketplace.json")).toBe(false);
    expect(await exists(out, ".claude-plugin/plugin.json")).toBe(true);
    await fs.rm(out, { recursive: true, force: true });
  });

  it("reports portability — universal skills/mcp, plugin hooks, terminal instructions", async () => {
    const out = await tmp();
    const result = await exportPlugin({ source: EXAMPLE, profile: "full", outDir: out });
    expect(result.portability.byCeiling.universal).toEqual(
      expect.arrayContaining(["skill", "mcp_server"]),
    );
    // Hooks are a Cowork-supported plugin component → plugin ceiling, not terminal.
    expect(result.portability.byCeiling.plugin).toEqual(expect.arrayContaining(["hook"]));
    // The whole pack's reach is still bounded by its instruction/rule atoms.
    expect(result.portability.overall).toBe("terminal");
    await fs.rm(out, { recursive: true, force: true });
  });

  it("a safe profile (skills/commands only) has no hooks but still bundles guidance", async () => {
    const out = await tmp();
    const result = await exportPlugin({ source: EXAMPLE, profile: "safe", outDir: out });
    expect(await exists(out, "hooks/hooks.json")).toBe(false);
    expect(await exists(out, "skills/pr-quality-guidance/SKILL.md")).toBe(true);
    // safe has instructions/rules → still terminal-bounded.
    expect(result.portability.overall).toBe("terminal");
    await fs.rm(out, { recursive: true, force: true });
  });
});

describe("portability", () => {
  it("classifies each atom type with a ceiling, mechanism, and note", () => {
    expect(portabilityFor("skill").ceiling).toBe("universal");
    expect(portabilityFor("mcp_server").ceiling).toBe("universal");
    expect(portabilityFor("command").ceiling).toBe("plugin");
    expect(portabilityFor("subagent").ceiling).toBe("plugin");
    expect(portabilityFor("hook").ceiling).toBe("plugin");
    expect(portabilityFor("instruction").ceiling).toBe("terminal");
    expect(portabilityFor("workflow").ceiling).toBe("sdk");
    for (const t of ["skill", "hook", "command", "workflow"] as const) {
      expect(portabilityFor(t).mechanism).toBeTruthy();
      expect(portabilityFor(t).note).toBeTruthy();
    }
  });

  it("overall reach is the least-portable atom present", () => {
    expect(summarizePortability(["skill", "mcp_server"]).overall).toBe("universal");
    expect(summarizePortability(["skill", "command"]).overall).toBe("plugin");
    expect(summarizePortability(["skill", "workflow"]).overall).toBe("sdk");
    expect(summarizePortability(["skill", "hook"]).overall).toBe("plugin");
    expect(summarizePortability(["skill", "instruction"]).overall).toBe("terminal");
    expect(summarizePortability([]).overall).toBe("universal");
  });

  it("groups types by ceiling without duplicates", () => {
    const s = summarizePortability(["skill", "skill", "hook", "command", "instruction"]);
    expect(s.byCeiling.universal).toEqual(["skill"]);
    expect(s.byCeiling.plugin).toEqual(["hook", "command"]);
    expect(s.byCeiling.terminal).toEqual(["instruction"]);
  });
});
