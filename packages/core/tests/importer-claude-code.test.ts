import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseClaudeCode,
  importClaudeCodeDir,
  validateManifest,
  writeImport,
  exportPack,
} from "../src/index.js";
import { parse as parseYaml } from "yaml";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/claude-code",
);

const OPTS = { id: "keen.full-setup", name: "Keen Full Setup" };

/** Build a virtual Claude Code tree (relPath → content) for pure-parser tests. */
function tree(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

describe("parseClaudeCode", () => {
  it("parses CLAUDE.md into instruction/rule sections", () => {
    const parsed = parseClaudeCode(
      tree({ "CLAUDE.md": "# T\n\n## Working Style\n\nbody\n\n## Git\n\n- never x\n" }),
    );
    expect(parsed.claudeMd?.sections.map((s) => s.heading)).toEqual([
      "Working Style",
      "Git",
    ]);
  });

  it("parses skills, agents (subagents), commands", () => {
    const parsed = parseClaudeCode(
      tree({
        "skills/code-review/SKILL.md":
          "---\nname: code-review\ndescription: Rev.\n---\n# CR\n",
        "agents/security-reviewer.md":
          "---\nname: security-reviewer\ndescription: Sec.\n---\nbody\n",
        "commands/standup.md": "---\ndescription: Standup.\n---\nprompt body\n",
      }),
    );
    expect(parsed.skills.map((s) => s.name)).toEqual(["code-review"]);
    expect(parsed.subagents.map((s) => s.name)).toEqual(["security-reviewer"]);
    expect(parsed.commands.map((c) => c.name)).toEqual(["standup"]);
  });

  it("parses hooks and mcpServers from settings.json", () => {
    const parsed = parseClaudeCode(
      tree({
        "settings.json": JSON.stringify({
          hooks: {
            PostToolUse: [
              { matcher: "Edit", hooks: [{ type: "command", command: "fmt.sh" }] },
            ],
          },
          mcpServers: {
            cf: { type: "http", url: "https://example.com/mcp" },
            db: { command: "npx", args: ["x"], env: { TOKEN: "${TOKEN}" } },
          },
        }),
      }),
    );
    expect(parsed.hooks).toEqual([{ event: "PostToolUse", command: "fmt.sh" }]);
    expect(parsed.mcpServers.map((m) => m.name).sort()).toEqual(["cf", "db"]);
    expect(parsed.mcpServers.find((m) => m.name === "cf")?.url).toBe(
      "https://example.com/mcp",
    );
    expect(parsed.mcpServers.find((m) => m.name === "db")?.env).toEqual({
      TOKEN: "${TOKEN}",
    });
  });
});

describe("importClaudeCodeDir (I/O against fixture)", () => {
  it("imports every atom type into a valid manifest", async () => {
    const result = await importClaudeCodeDir(FIXTURE_DIR, OPTS);
    const types = new Set(result.manifest.atoms.map((a) => a.type));
    // CLAUDE.md → instruction + rule; plus skill, subagent, command, hook, mcp_server.
    expect(types).toEqual(
      new Set([
        "instruction",
        "rule",
        "skill",
        "subagent",
        "command",
        "hook",
        "mcp_server",
      ]),
    );
    // Manifest is schema-valid.
    const v = validateManifest(result.manifest);
    expect(v.valid, JSON.stringify(v.errors)).toBe(true);
    // Two MCP servers (remote http + stdio).
    expect(result.manifest.atoms.filter((a) => a.type === "mcp_server")).toHaveLength(2);
  });

  it("marks only Claude Code as natively supported", async () => {
    const result = await importClaudeCodeDir(FIXTURE_DIR, OPTS);
    expect(result.manifest.compatibility.targets["claude-code"]?.status).toBe("supported");
    expect(result.manifest.compatibility.targets.codex?.status).toBe("partial");
    expect(result.manifest.compatibility.targets.codex?.notes).toMatch(/compiled.*verify/i);
  });

  it("downgrades Claude Code when malformed source artifacts are skipped", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-code-warning-"));
    try {
      await fs.writeFile(path.join(dir, "CLAUDE.md"), "## Working Style\n\nbody\n");
      await fs.writeFile(path.join(dir, "settings.json"), "{ malformed");
      const result = await importClaudeCodeDir(dir, { id: "acme.warning" });
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.manifest.compatibility.targets["claude-code"]?.status).toBe("partial");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces the stdio MCP secret but NEVER ships the token value", async () => {
    const result = await importClaudeCodeDir(FIXTURE_DIR, OPTS);
    // The env KEY is surfaced as a required secret slot…
    const secrets = result.manifest.permissions?.secrets?.required ?? [];
    expect(secrets.some((s) => s.name === "SUPABASE_ACCESS_TOKEN")).toBe(true);
    // …and NO file carries the .credentials.json sentinel value.
    const blob = result.files.map((f) => f.content).join("\n");
    expect(blob).not.toContain("CREDENTIAL-SENTINEL-MUST-NOT-BE-IMPORTED");
  });

  it("emits a working command (yaml descriptor + prompt body)", async () => {
    const result = await importClaudeCodeDir(FIXTURE_DIR, OPTS);
    const cmdDescriptor = result.files.find((f) =>
      /atoms\/commands\/[^/]+\.yaml$/.test(f.relativePath),
    );
    expect(cmdDescriptor).toBeDefined();
    const parsed = parseYaml(cmdDescriptor!.content) as { prompt?: string };
    expect(parsed.prompt).toMatch(/atoms\/commands\/prompts\//);
    expect(result.files.some((f) => f.relativePath === parsed.prompt)).toBe(true);
  });

  it("preserves agent tools/model frontmatter through import → export (#91 follow-up)", async () => {
    const result = await importClaudeCodeDir(FIXTURE_DIR, OPTS);
    // The subagent now references a verbatim `.md`, not a YAML descriptor.
    const subAtom = result.manifest.atoms.find(
      (a) => a.id === "subagent:security-reviewer",
    );
    expect(subAtom?.path).toMatch(/atoms\/subagents\/.*\.md$/);

    // Write the imported pack to disk, compile it to claude-code, and confirm
    // tools/model + the real prompt body all round-trip into the emitted agent.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-cc-roundtrip-"));
    try {
      await writeImport(result, path.join(tmp, "pack"));
      await exportPack({
        source: path.join(tmp, "pack"),
        target: "claude-code",
        outDir: path.join(tmp, "out"),
      });
      const emitted = await fs.readFile(
        path.join(tmp, "out/.claude/agents/security-reviewer.md"),
        "utf8",
      );
      expect(emitted).toMatch(/^tools:\s*Read, Grep, Glob, Bash\s*$/m);
      expect(emitted).toMatch(/^model:\s*sonnet\s*$/m);
      expect(emitted).toContain("You are a security reviewer.");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
