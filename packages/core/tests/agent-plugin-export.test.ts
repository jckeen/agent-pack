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

/** Minimal claude-code pack declaring remote (URL) MCP servers. */
async function writeRemoteMcpPack(
  dir: string,
  servers: Array<{ name: string; url: string }>,
): Promise<void> {
  const atoms = servers
    .map(
      (s) => `  - id: "mcp_server:${s.name}"
    type: mcp_server
    name: "${s.name}"
    description: "Remote MCP server ${s.name}."
    path: "atoms/mcp/${s.name}.yaml"
    risk_level: high
    permissions:
      - network.access
      - external_api.access
    transport: http
    url: "${s.url}"`,
    )
    .join("\n");
  await fs.writeFile(
    path.join(dir, "AGENTPACK.yaml"),
    `agentpack: "1.0"
metadata:
  id: "fixture.remote-mcp"
  name: "Remote MCP Fixture"
  slug: "remote-mcp"
  description: "Remote MCP servers over http/https."
  version: "1.0.0"
  license: "MIT"
  publisher: "fixture"
compatibility:
  targets:
    claude-code:
      status: supported
permissions:
  network:
    access: optional
  mcp:
    servers:
${servers.map((s) => `      - "${s.name}"`).join("\n")}
  external_apis:
${servers.map((s) => `    - "${s.name}"`).join("\n")}
security:
  risk_level: high
  risk_summary: "Remote MCP."
  requires_review: false
  signed: false
profiles:
  full:
    description: "Everything."
    include:
      - "*"
atoms:
${atoms}
exports:
  default_profile: full
`,
    "utf8",
  );
  await fs.mkdir(path.join(dir, "atoms/mcp"), { recursive: true });
  for (const s of servers) {
    await fs.writeFile(
      path.join(dir, `atoms/mcp/${s.name}.yaml`),
      `id: ${s.name}\nname: ${s.name}\ntransport: http\nurl: "${s.url}"\n`,
      "utf8",
    );
  }
}

describe("exportAgentPlugin MCP remote URL policy (#221)", () => {
  it("reports original atom ids when non-strict export normalizes server names", async () => {
    const pack = await tmp();
    const out = await tmp();
    try {
      await writeRemoteMcpPack(pack, [{ name: "bad_name", url: "http://example.com/mcp" }]);
      const manifestPath = path.join(pack, "AGENTPACK.yaml");
      await fs.writeFile(
        manifestPath,
        (await read(pack, "AGENTPACK.yaml")).replace(
          'id: "mcp_server:bad_name"',
          'id: "mcp_server:bad$name"',
        ),
      );
      const result = await exportAgentPlugin({
        source: pack,
        outDir: out,
        strict: false,
      });
      expect(result.writtenFiles).not.toContain("mcp.json");
      expect(result.plan.warnings.join("\n")).toMatch(/`bad_name` omitted/);
      expect(result.plan.unsupportedAtoms).toEqual(["mcp_server:bad$name"]);
      expect(result.portability.byCeiling.universal).toEqual([]);
    } finally {
      await fs.rm(pack, { recursive: true, force: true });
      await fs.rm(out, { recursive: true, force: true });
    }
  });

  it("refuses non-loopback plaintext http servers with an actionable warning; https and loopback survive", async () => {
    const pack = await tmp();
    const out = await tmp();
    await writeRemoteMcpPack(pack, [
      { name: "plain", url: "http://example.com/mcp" },
      { name: "local", url: "http://localhost:3000/mcp" },
      { name: "secure", url: "https://example.com/mcp" },
    ]);
    const result = await exportAgentPlugin({ source: pack, profile: "full", outDir: out });
    const mcp = JSON.parse(await read(out, "mcp.json"));
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["local", "secure"]);
    expect(validateAgentPluginMcpConfig(mcp).errors).toEqual([]);
    const warning = result.plan.warnings.find((w) => w.includes("`plain`"));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/https/i);
    expect(warning).toMatch(/localhost/i);
    expect(result.plan.unsupportedAtoms).toEqual(["mcp_server:plain"]);
    expect(result.portability.byCeiling.universal).toEqual(["mcp_server"]);
    await fs.rm(pack, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  });

  it("writes no mcp.json at all when every server is refused (no malformed artifact)", async () => {
    const pack = await tmp();
    const out = await tmp();
    await writeRemoteMcpPack(pack, [{ name: "plain", url: "http://example.com/mcp" }]);
    const result = await exportAgentPlugin({ source: pack, profile: "full", outDir: out });
    expect(await exists(out, "mcp.json")).toBe(false);
    expect(
      validateAgentPluginManifest(JSON.parse(await read(out, "plugin.json"))).errors,
    ).toEqual([]);
    expect(result.plan.warnings.join("\n")).toMatch(/`plain`/);
    expect(result.plan.unsupportedAtoms).toEqual(["mcp_server:plain"]);
    expect(result.plan.observedFidelity).toBe("partial");
    expect(result.portability.byCeiling.universal).toEqual([]);
    await fs.rm(pack, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  });
});

/** Copy the example pack and add authored skills with the given slugs. */
async function exampleWithSkills(dir: string, slugs: string[]): Promise<void> {
  await fs.cp(EXAMPLE, dir, { recursive: true });
  const manifestPath = path.join(dir, "AGENTPACK.yaml");
  const atoms = slugs
    .map(
      (slug) => `  - id: "skill:${slug}"
    type: skill
    name: "Authored ${slug}"
    description: "An authored skill that happens to be named ${slug}."
    path: "atoms/skills/${slug}"
    skill_format: "agentskills"
    risk_level: low
    permissions: []
`,
    )
    .join("\n");
  const manifest = await fs.readFile(manifestPath, "utf8");
  expect(manifest).toContain("\nexports:\n");
  await fs.writeFile(
    manifestPath,
    manifest.replace("\nexports:\n", `\n${atoms}\nexports:\n`),
  );
  for (const slug of slugs) {
    await fs.mkdir(path.join(dir, "atoms/skills", slug), { recursive: true });
    await fs.writeFile(
      path.join(dir, "atoms/skills", slug, "SKILL.md"),
      `---\nname: ${slug}\ndescription: Authored ${slug}.\n---\n\n# AUTHORED ${slug}\n`,
      "utf8",
    );
  }
}

describe("exportAgentPlugin guidance skill collision (#220)", () => {
  it("never overwrites an authored skill at the guidance path, even when suffixes are taken", async () => {
    const pack = await tmp();
    const out = await tmp();
    await exampleWithSkills(pack, ["pr-quality-guidance", "pr-quality-guidance-2"]);
    const result = await exportAgentPlugin({ source: pack, profile: "full", outDir: out });
    expect(await read(out, "skills/pr-quality-guidance/SKILL.md")).toContain(
      "# AUTHORED pr-quality-guidance",
    );
    expect(await read(out, "skills/pr-quality-guidance-2/SKILL.md")).toContain(
      "# AUTHORED pr-quality-guidance-2",
    );
    const guidance = await read(out, "skills/pr-quality-guidance-3/SKILL.md");
    expect(guidance).toMatch(/^---\nname: pr-quality-guidance-3/);
    expect(guidance).toContain("PR Review Standards");
    expect(result.plan.warnings.join("\n")).toMatch(/pr-quality-guidance-3/);
    await fs.rm(pack, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  });
});

describe("importAgentPluginDir metadata (#218)", () => {
  it("caller metadata overrides plugin metadata while unspecified fields survive", async () => {
    const out = await tmp();
    try {
      await exportAgentPlugin({ source: EXAMPLE, profile: "safe", outDir: out });
      const metadata = {
        license: "Apache-2.0",
        authors: [{ name: "Caller" }],
        homepage: "https://example.com/custom",
        tags: [],
      };
      const result = await importAgentPluginDir(out, {
        id: "acme.custom",
        metadata,
      });
      expect(result.manifest.metadata).toMatchObject(metadata);
      expect(result.manifest.metadata.description).toBe(
        "Cross-platform pull request review workflow with code review, security review, formatting, and PR summary generation.",
      );
      expect(result.files[0]!.content).toContain("license: Apache-2.0");
    } finally {
      await fs.rm(out, { recursive: true, force: true });
    }
  });

  it("carries a foreign plugin's description/author/homepage/repository/license/keywords into the manifest", async () => {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
        name: "foreign-plugin",
        version: "2.3.4",
        description: "A plugin someone else published.",
        author: {
          name: "Someone",
          email: "someone@example.com",
          url: "https://example.com",
        },
        homepage: "https://example.com/foreign",
        repository: "https://github.com/example/foreign",
        license: "Apache-2.0",
        keywords: ["review", "quality"],
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
    const result = await importAgentPluginDir(dir, { id: "acme.foreign" });
    const m = result.manifest.metadata;
    expect(m.name).toBe("foreign-plugin");
    expect(m.version).toBe("2.3.4");
    expect(m.description).toBe("A plugin someone else published.");
    expect(m.authors).toEqual([
      { name: "Someone", email: "someone@example.com", url: "https://example.com" },
    ]);
    expect(m.homepage).toBe("https://example.com/foreign");
    expect(m.repository).toBe("https://github.com/example/foreign");
    expect(m.license).toBe("Apache-2.0");
    expect(m.tags).toEqual(["review", "quality"]);
    // The emitted AGENTPACK.yaml validates as a pack.
    expect(result.files[0]!.content).toContain("homepage: https://example.com/foreign");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not invent metadata: an author without a name and a non-URL homepage are left out", async () => {
    const dir = await tmp();
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
        name: "sparse-plugin",
        author: { email: "anon@example.com" },
        homepage: "not a url",
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
    const result = await importAgentPluginDir(dir, { id: "acme.sparse" });
    const m = result.manifest.metadata;
    expect(m.authors).toBeUndefined();
    expect(m.homepage).toBeUndefined();
    expect(m.tags).toBeUndefined();
    expect(m.repository).toBeUndefined();
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(/homepage/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips the example pack's metadata and lets explicit CLI identity win", async () => {
    const out = await tmp();
    await exportAgentPlugin({ source: EXAMPLE, profile: "full", outDir: out });
    const roundTrip = await importAgentPluginDir(out, { id: "acme.reimported" });
    expect(roundTrip.manifest.metadata.description).toBe(
      "Cross-platform pull request review workflow with code review, security review, formatting, and PR summary generation.",
    );
    expect(roundTrip.manifest.metadata.authors).toEqual([
      { name: "AgentPack", email: "hello@agentpack.dev" },
    ]);
    expect(roundTrip.manifest.metadata.tags).toEqual([
      "pull-request",
      "code-review",
      "security",
      "developer-workflow",
    ]);
    expect(roundTrip.manifest.metadata.license).toBe("MIT");
    expect(roundTrip.manifest.metadata.homepage).toBeUndefined();

    const explicit = await importAgentPluginDir(out, {
      id: "acme.custom",
      name: "Custom Name",
      version: "9.9.9",
    });
    expect(explicit.manifest.metadata.name).toBe("Custom Name");
    expect(explicit.manifest.metadata.version).toBe("9.9.9");
    await fs.rm(out, { recursive: true, force: true });
  });
});
