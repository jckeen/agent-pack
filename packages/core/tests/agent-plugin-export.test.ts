import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { exportAgentPlugin } from "../src/exports/exportAgentPlugin.js";
import { importAgentPluginDir } from "../src/importer/importAgentPlugin.js";
import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
  AGENT_PLUGIN_MCP_SCHEMA_ID,
  AGENTPACK_EXTENSION_NAMESPACE,
  validateAgentPluginManifest,
  validateAgentPluginMcpConfig,
} from "../src/exports/agentplugins.js";
import { validateSkillMdContent } from "../src/skills/agentskills.js";

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");
const NS = AGENTPACK_EXTENSION_NAMESPACE;

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-agent-plugin-"));
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

describe("exportAgentPlugin", () => {
  it("emits a spec-conformant Agent Plugins 1.0 directory for the full profile", async () => {
    const out = await tmp();
    const result = await exportAgentPlugin({
      source: EXAMPLE,
      profile: "full",
      outDir: out,
    });
    expect(result.pluginName).toBe("pr-quality");

    // plugin.json — closed root, pinned $schema, conformant name.
    const manifest = JSON.parse(await read(out, "plugin.json"));
    expect(manifest.$schema).toBe(AGENT_PLUGIN_MANIFEST_SCHEMA_ID);
    expect(manifest.name).toBe("pr-quality");
    const { errors } = validateAgentPluginManifest(manifest);
    expect(errors).toEqual([]);

    // No Claude-Code-only manifest files in a spec export.
    expect(await exists(out, ".claude-plugin/plugin.json")).toBe(false);

    // Governance rides in the AgentPack extensions namespace.
    expect(manifest.extensions?.[NS]?.pack?.id).toBe("agentpack.pr-quality");
    expect(manifest.extensions?.[NS]?.profile).toBe("full");

    // Skills at the spec's fixed location, each spec-conformant.
    expect(await exists(out, "skills/code-review/SKILL.md")).toBe(true);
    const skill = await read(out, "skills/code-review/SKILL.md");
    expect(validateSkillMdContent(skill, "code-review")).toEqual([]);

    // Instruction/rule guidance bridges as a portable skill (like pack plugin).
    expect(await exists(out, "skills/pr-quality-guidance/SKILL.md")).toBe(true);

    // mcp.json in spec format — pinned $schema, explicit type per server.
    const mcp = JSON.parse(await read(out, "mcp.json"));
    expect(mcp.$schema).toBe(AGENT_PLUGIN_MCP_SCHEMA_ID);
    expect(validateAgentPluginMcpConfig(mcp).errors).toEqual([]);
    for (const server of Object.values(mcp.mcpServers) as Array<{ type: string }>) {
      expect(["stdio", "streamable-http", "sse"]).toContain(server.type);
    }

    // Non-portable v1 components live under the extension namespace directory.
    expect(await exists(out, `${NS}/commands/pr-summary.md`)).toBe(true);
    expect(await exists(out, `${NS}/agents/security-reviewer.md`)).toBe(true);
    expect(await exists(out, `${NS}/hooks/hooks.json`)).toBe(true);
    expect(await exists(out, "commands/pr-summary.md")).toBe(false);
    expect(await exists(out, "hooks/hooks.json")).toBe(false);
    expect(result.extensionFiles).toEqual(
      expect.arrayContaining([
        `${NS}/commands/pr-summary.md`,
        `${NS}/hooks/hooks.json`,
      ]),
    );

    await fs.rm(out, { recursive: true, force: true });
  });

  it("safe profile emits no extension hooks and stays spec-conformant", async () => {
    const out = await tmp();
    await exportAgentPlugin({ source: EXAMPLE, profile: "safe", outDir: out });
    expect(await exists(out, `${NS}/hooks/hooks.json`)).toBe(false);
    const manifest = JSON.parse(await read(out, "plugin.json"));
    expect(validateAgentPluginManifest(manifest).errors).toEqual([]);
    await fs.rm(out, { recursive: true, force: true });
  });

  it("drops mcp env placeholders (spec has no user-env expansion) and says so", async () => {
    const out = await tmp();
    const result = await exportAgentPlugin({
      source: EXAMPLE,
      profile: "full",
      outDir: out,
    });
    const mcp = JSON.parse(await read(out, "mcp.json"));
    for (const server of Object.values(mcp.mcpServers) as Array<{
      env?: Record<string, string>;
    }>) {
      for (const value of Object.values(server.env ?? {})) {
        expect(value).not.toMatch(/^\$\{(?!PLUGIN_ROOT|PLUGIN_DATA).+\}$/);
      }
    }
    expect(result.plan.warnings.join("\n")).toMatch(/env/i);
    await fs.rm(out, { recursive: true, force: true });
  });
});

describe("importAgentPluginDir (round-trip)", () => {
  it("re-imports an exported plugin into a pack with the portable atoms", async () => {
    const out = await tmp();
    await exportAgentPlugin({ source: EXAMPLE, profile: "full", outDir: out });

    const result = await importAgentPluginDir(out, { id: "acme.reimported" });
    const types = new Map<string, number>();
    for (const atom of result.manifest.atoms) {
      types.set(atom.type, (types.get(atom.type) ?? 0) + 1);
    }
    // Portable core: skills + MCP servers come back as first-class atoms.
    expect(types.get("skill") ?? 0).toBeGreaterThanOrEqual(2); // code-review + guidance
    expect(types.get("mcp_server") ?? 0).toBeGreaterThanOrEqual(1);
    // Our own extension namespace round-trips commands/agents/hooks.
    expect(types.get("command") ?? 0).toBeGreaterThanOrEqual(1);
    expect(types.get("subagent") ?? 0).toBeGreaterThanOrEqual(1);
    expect(types.get("hook") ?? 0).toBeGreaterThanOrEqual(1);
    expect(result.manifest.metadata.id).toBe("acme.reimported");

    await fs.rm(out, { recursive: true, force: true });
  });

  it("warns about foreign extension namespaces instead of dropping them silently", async () => {
    const out = await tmp();
    await exportAgentPlugin({ source: EXAMPLE, profile: "safe", outDir: out });
    await fs.mkdir(path.join(out, "com.example.other"), { recursive: true });
    await fs.writeFile(
      path.join(out, "com.example.other", "config.json"),
      "{}\n",
      "utf8",
    );
    const result = await importAgentPluginDir(out, { id: "acme.reimported" });
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(
      /com\.example\.other/,
    );
    await fs.rm(out, { recursive: true, force: true });
  });

  it("rejects a directory without a plugin.json manifest", async () => {
    const out = await tmp();
    await expect(importAgentPluginDir(out, { id: "acme.reimported" })).rejects.toThrow(
      /plugin\.json/,
    );
    await fs.rm(out, { recursive: true, force: true });
  });
});
