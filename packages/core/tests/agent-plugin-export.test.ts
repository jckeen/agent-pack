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
      expect.arrayContaining([`${NS}/commands/pr-summary.md`, `${NS}/hooks/hooks.json`]),
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
    await fs.writeFile(path.join(out, "com.example.other", "config.json"), "{}\n", "utf8");
    const result = await importAgentPluginDir(out, { id: "acme.reimported" });
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(/com\.example\.other/);
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

describe("importAgentPluginDir hardening", () => {
  async function minimalPluginDir(): Promise<string> {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "hardening-fixture",
      }),
      "utf8",
    );
    return dir;
  }

  it("skips symlinks that escape the plugin root and warns instead of reading them", async () => {
    const dir = await minimalPluginDir();
    const secret = path.join(dir, "..", `agentpack-secret-${path.basename(dir)}`);
    await fs.writeFile(secret, "SECRET-CONTENT-DO-NOT-PACKAGE\n", "utf8");
    const cmdDir = path.join(dir, "dev.agentpack", "commands");
    await fs.mkdir(cmdDir, { recursive: true });
    await fs.symlink(secret, path.join(cmdDir, "leak.md"));
    // A plugin-internal symlink is fine per the spec — it must survive.
    const skillDir = path.join(dir, "skills", "inside");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: inside\ndescription: internal skill\n---\n\nBody.\n",
      "utf8",
    );

    const result = await importAgentPluginDir(dir, { id: "acme.hardening" });
    for (const f of result.files) {
      expect(f.content).not.toContain("SECRET-CONTENT-DO-NOT-PACKAGE");
    }
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(/leak\.md/);
    expect(result.manifest.atoms.some((a) => a.type === "skill")).toBe(true);

    await fs.rm(secret, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("follows plugin-internal directory symlinks and survives symlink cycles", async () => {
    const dir = await minimalPluginDir();
    // skills/ itself is an internal symlink to a real directory in the root.
    const realSkills = path.join(dir, "real-skills");
    await fs.mkdir(path.join(realSkills, "linked"), { recursive: true });
    await fs.writeFile(
      path.join(realSkills, "linked", "SKILL.md"),
      "---\nname: linked\ndescription: reached via internal dir symlink\n---\n\nBody.\n",
      "utf8",
    );
    await fs.symlink(realSkills, path.join(dir, "skills"));
    // A directory symlink cycle must not hang the walk.
    await fs.symlink(realSkills, path.join(realSkills, "cycle"));

    const result = await importAgentPluginDir(dir, { id: "acme.hardening" });
    expect(result.manifest.atoms.some((a) => a.type === "skill")).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  }, 15000);

  it("follows symlinked namespace directories and their symlinked subdirectories", async () => {
    const dir = await minimalPluginDir();
    // dev.agentpack is an internal symlink; its commands/ is another one.
    const realNs = path.join(dir, "real-ns");
    const realCommands = path.join(dir, "real-commands");
    await fs.mkdir(realNs, { recursive: true });
    await fs.mkdir(realCommands, { recursive: true });
    await fs.writeFile(
      path.join(realCommands, "hello.md"),
      "---\ndescription: says hello\n---\n\nSay hello.\n",
      "utf8",
    );
    await fs.symlink(realCommands, path.join(realNs, "commands"));
    await fs.symlink(realNs, path.join(dir, "dev.agentpack"));

    const result = await importAgentPluginDir(dir, { id: "acme.hardening" });
    expect(result.manifest.atoms.some((a) => a.type === "command")).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("warns on duplicate bundled hook-script basenames and keeps the first", async () => {
    const dir = await minimalPluginDir();
    const hooksDir = path.join(dir, "dev.agentpack", "hooks");
    await fs.mkdir(path.join(hooksDir, "nested"), { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: "bash ${CLAUDE_PROJECT_DIR}/.claude/hooks/lint.sh",
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(hooksDir, "lint.sh"),
      "#!/usr/bin/env bash\necho first\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(hooksDir, "nested", "lint.sh"),
      "#!/usr/bin/env bash\necho second\n",
      "utf8",
    );
    const result = await importAgentPluginDir(dir, { id: "acme.hardening" });
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(/[Dd]uplicate/);
    const script = result.files.find((f) =>
      f.relativePath.startsWith("atoms/hooks/scripts/"),
    );
    expect(script).toBeDefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not attach a hook script whose basename merely appears inside another filename", async () => {
    const dir = await minimalPluginDir();
    const hooksDir = path.join(dir, "dev.agentpack", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: "bash ${CLAUDE_PROJECT_DIR}/.claude/hooks/prelint.sh",
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );
    // Only `lint.sh` ships — it is NOT the referenced `prelint.sh` and must
    // not be attached to the hook on a substring match.
    await fs.writeFile(
      path.join(hooksDir, "lint.sh"),
      "#!/usr/bin/env bash\necho lint\n",
      "utf8",
    );
    const result = await importAgentPluginDir(dir, { id: "acme.hardening" });
    expect(
      result.files.some((f) => f.relativePath.startsWith("atoms/hooks/scripts/")),
    ).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("skips non-UTF-8 files even when they contain no NUL byte", async () => {
    const dir = await minimalPluginDir();
    const skillDir = path.join(dir, "skills", "latin");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: latin\ndescription: has a latin-1 reference\n---\n\nBody.\n",
      "utf8",
    );
    // Latin-1 "café" — 0xE9 is invalid UTF-8 but contains no NUL.
    await fs.writeFile(
      path.join(skillDir, "notes.txt"),
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    );
    const result = await importAgentPluginDir(dir, { id: "acme.hardening" });
    expect(result.files.some((f) => f.relativePath.endsWith("notes.txt"))).toBe(false);
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(/notes\.txt/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("skips binary files with a warning instead of corrupting them via UTF-8", async () => {
    const dir = await minimalPluginDir();
    const skillDir = path.join(dir, "skills", "binskill");
    await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: binskill\ndescription: has a binary asset\n---\n\nBody.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(skillDir, "assets", "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    );
    const result = await importAgentPluginDir(dir, { id: "acme.hardening" });
    expect(result.files.some((f) => f.relativePath.endsWith("logo.png"))).toBe(false);
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(/logo\.png/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("warns when MCP servers carry cwd, headers, or env values it cannot represent", async () => {
    const dir = await minimalPluginDir();
    await fs.writeFile(
      path.join(dir, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          local: { type: "stdio", command: "srv", env: { MODE: "prod" }, cwd: "./srv" },
          remote: {
            type: "streamable-http",
            url: "https://example.com/mcp",
            headers: { "X-Team": "a" },
          },
        },
      }),
      "utf8",
    );
    const result = await importAgentPluginDir(dir, { id: "acme.hardening" });
    const text = result.warnings.map((w) => w.message).join("\n");
    expect(text).toMatch(/cwd/);
    expect(text).toMatch(/headers/);
    expect(text).toMatch(/env/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("re-bundles hook scripts shipped in the extension namespace", async () => {
    const dir = await minimalPluginDir();
    const hooksDir = path.join(dir, "dev.agentpack", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit",
              hooks: [
                {
                  type: "command",
                  command: "bash ${CLAUDE_PROJECT_DIR}/.claude/hooks/lint.sh",
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(hooksDir, "lint.sh"),
      "#!/usr/bin/env bash\necho lint\n",
      "utf8",
    );
    const result = await importAgentPluginDir(dir, { id: "acme.hardening" });
    const script = result.files.find((f) =>
      f.relativePath.startsWith("atoms/hooks/scripts/"),
    );
    expect(script).toBeDefined();
    expect(script!.content).toContain("echo lint");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("warns about manifest-only foreign extension namespaces", async () => {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "hardening-fixture",
        extensions: { "com.example.other": { anything: true } },
      }),
      "utf8",
    );
    const skillDir = path.join(dir, "skills", "s");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: s\ndescription: skill\n---\n\nBody.\n",
      "utf8",
    );
    const result = await importAgentPluginDir(dir, { id: "acme.hardening" });
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(/com\.example\.other/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves command argument hints through the round-trip", async () => {
    const out = await tmp();
    await exportAgentPlugin({ source: EXAMPLE, profile: "full", outDir: out });
    const result = await importAgentPluginDir(out, { id: "acme.reimported" });
    const descriptor = result.files.find(
      (f) =>
        f.relativePath.startsWith("atoms/commands/") &&
        f.relativePath.endsWith(".yaml") &&
        f.content.includes("pr-summary"),
    );
    expect(descriptor).toBeDefined();
    expect(descriptor!.content).toMatch(/arguments:/);
    expect(descriptor!.content).toMatch(/base/);
    await fs.rm(out, { recursive: true, force: true });
  });
});

describe("exportAgentPlugin outDir safety", () => {
  it("cleans managed outputs when reusing an outDir, so a safe export can't retain full-profile hooks", async () => {
    const out = await tmp();
    await exportAgentPlugin({ source: EXAMPLE, profile: "full", outDir: out });
    expect(await exists(out, `${NS}/hooks/hooks.json`)).toBe(true);
    await exportAgentPlugin({ source: EXAMPLE, profile: "safe", outDir: out });
    // safe still ships commands (freshly written); the full profile's hooks
    // must NOT survive the re-export.
    expect(await exists(out, `${NS}/hooks/hooks.json`)).toBe(false);
    expect(await exists(out, `${NS}/commands/pr-summary.md`)).toBe(true);
    await fs.rm(out, { recursive: true, force: true });
  });

  it("refuses to write through a symlinked component path in outDir", async () => {
    const out = await tmp();
    const elsewhere = await tmp();
    await fs.symlink(elsewhere, path.join(out, "skills"));
    await expect(
      exportAgentPlugin({ source: EXAMPLE, profile: "full", outDir: out }),
    ).rejects.toThrow(/symlink|outside/i);
    const escaped = await fs.readdir(elsewhere);
    expect(escaped).toEqual([]);
    await fs.rm(out, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  });
});
