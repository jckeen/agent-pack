import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseCodex,
  buildCodexManifest,
  importCodexDir,
  validateManifest,
  agentPackManifestSchema,
  getAdapter,
  resolveAtoms,
} from "../src/index.js";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/codex",
);

const OPTS = { id: "acme.codex", name: "Acme Codex" };

/** Build a virtual Codex tree (relPath → content) for pure-parser tests. */
function tree(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

describe("parseCodex", () => {
  it("parses AGENTS.md into instruction/rule sections", () => {
    const parsed = parseCodex(
      tree({
        "AGENTS.md": "# T\n\n## Working Style\n\nbody\n\n## Git\n\n- never x\n",
      }),
    );
    expect(parsed.agents?.sections.map((s) => s.heading)).toEqual(["Working Style", "Git"]);
  });

  it("parses skills from .agents/skills/<name>/SKILL.md", () => {
    const parsed = parseCodex(
      tree({
        ".agents/skills/code-review/SKILL.md":
          "---\nname: code-review\ndescription: Review a PR.\n---\n\n# CR\n\nbody\n",
        ".agents/skills/code-review/checklist.md": "- a\n",
      }),
    );
    expect(parsed.skills).toHaveLength(1);
    const skill = parsed.skills[0]!;
    expect(skill.name).toBe("code-review");
    expect(skill.files.map((f) => f.relPath).sort()).toEqual(["SKILL.md", "checklist.md"]);
  });

  it("parses [mcp_servers.*] from config.toml", () => {
    const parsed = parseCodex(
      tree({
        ".codex/config.toml": [
          "[mcp_servers.github]",
          'command = "npx"',
          'args = ["-y", "server-github"]',
          'env = { GITHUB_TOKEN = "x" }',
          'enabled_tools = ["a"]',
          'disabled_tools = ["b"]',
        ].join("\n"),
      }),
    );
    expect(parsed.mcpServers).toHaveLength(1);
    const m = parsed.mcpServers[0]!;
    expect(m.name).toBe("github");
    expect(m.command).toBe("npx");
    expect(m.args).toEqual(["-y", "server-github"]);
    expect(Object.keys(m.env ?? {})).toEqual(["GITHUB_TOKEN"]);
    expect(m.enabledTools).toEqual(["a"]);
    expect(m.disabledTools).toEqual(["b"]);
  });

  it("parses [hooks] tables with Claude-compatible event names", () => {
    const parsed = parseCodex(
      tree({
        ".codex/config.toml": [
          "[[hooks.PostToolUse]]",
          'command = "npm run format"',
          "[[hooks.SessionStart]]",
          'command = "git status"',
        ].join("\n"),
      }),
    );
    const events = parsed.hooks.map((h) => h.event).sort();
    expect(events).toEqual(["PostToolUse", "SessionStart"]);
    const post = parsed.hooks.find((h) => h.event === "PostToolUse")!;
    expect(post.command).toBe("npm run format");
  });

  it("parses hooks.json as an alternative hook source", () => {
    const parsed = parseCodex(
      tree({
        ".codex/hooks.json": JSON.stringify({
          hooks: { PreToolUse: [{ command: "echo hi" }] },
        }),
      }),
    );
    expect(parsed.hooks).toHaveLength(1);
    expect(parsed.hooks[0]!.event).toBe("PreToolUse");
    expect(parsed.hooks[0]!.command).toBe("echo hi");
  });

  it("parses subagent .toml definitions", () => {
    const parsed = parseCodex(
      tree({
        ".codex/agents/sec.toml": '[agent]\nid = "sec"\nname = "Sec"\ndescription = "d"\n',
      }),
    );
    expect(parsed.subagents).toHaveLength(1);
    expect(parsed.subagents[0]!.name).toBe("Sec");
  });

  it("warns and skips malformed TOML rather than throwing", () => {
    const parsed = parseCodex(tree({ ".codex/config.toml": "this = = broken" }));
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.warnings.some((w) => /config\.toml/.test(w.message))).toBe(true);
  });
});

describe("parseCodex — preamble preservation", () => {
  it("captures the AGENTS.md preamble as a synthetic leading section (fixes #57)", () => {
    // The fixture AGENTS.md has a preamble paragraph between the # title and
    // the first ## section.  Before the fix this text was silently discarded.
    const parsed = parseCodex(
      tree({
        "AGENTS.md": [
          "# Project Setup",
          "",
          "Project conventions for working in this repo with Codex.",
          "",
          "## Working Style",
          "",
          "body",
        ].join("\n"),
      }),
    );
    const sections = parsed.agents?.sections ?? [];
    // Synthetic preamble section + the real ## section = 2 total.
    expect(sections).toHaveLength(2);
    expect(sections[0]!.heading).toBe("Project Setup");
    expect(sections[0]!.body).toContain(
      "Project conventions for working in this repo with Codex.",
    );
    expect(sections[1]!.heading).toBe("Working Style");
  });
});

describe("buildCodexManifest", () => {
  it("emits a schema-valid, semantically-valid manifest from the fixture", async () => {
    const parsed = await readFixture();
    const { manifest } = buildCodexManifest(parsed, OPTS);
    expect(() => agentPackManifestSchema.parse(manifest)).not.toThrow();
    const validation = validateManifest(manifest);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("marks only the imported runtime as natively supported", async () => {
    const parsed = await readFixture();
    const { manifest } = buildCodexManifest(parsed, OPTS);
    expect(manifest.compatibility.targets.codex?.status).toBe("supported");
    expect(manifest.compatibility.targets["claude-code"]?.status).toBe("partial");
    expect(manifest.compatibility.targets["claude-code"]?.notes).toMatch(
      /compiled.*verify/i,
    );
  });

  it("maps each Codex primitive to the right atom type", async () => {
    const parsed = await readFixture();
    const { manifest } = buildCodexManifest(parsed, OPTS);
    const types = new Set(manifest.atoms.map((a) => a.type));
    expect(types.has("skill")).toBe(true);
    expect(types.has("mcp_server")).toBe(true);
    expect(types.has("hook")).toBe(true);
    expect(types.has("subagent")).toBe(true);
    // AGENTS.md → instruction and rule.
    expect(types.has("instruction")).toBe(true);
    expect(types.has("rule")).toBe(true);
  });

  it("declares permissions implied by hook and mcp atoms (no validator warnings)", async () => {
    const parsed = await readFixture();
    const { manifest } = buildCodexManifest(parsed, OPTS);
    const validation = validateManifest(manifest);
    const codes = validation.warnings.map((w) => w.code);
    expect(codes).not.toContain("permission.declared_shell_missing");
    expect(codes).not.toContain("permission.declared_secrets_missing");
  });

  it("carries mcp command/args/env and the shell hook command into permissions", async () => {
    const parsed = await readFixture();
    const { manifest } = buildCodexManifest(parsed, OPTS);
    expect(manifest.permissions?.mcp?.servers).toContain("github");
    expect(manifest.permissions?.shell?.commands).toContain("npm run format");
  });

  it("prefixes every atom id with its type", async () => {
    const parsed = await readFixture();
    const { manifest } = buildCodexManifest(parsed, OPTS);
    for (const atom of manifest.atoms) {
      expect(atom.id.startsWith(`${atom.type}:`)).toBe(true);
    }
  });
});

describe("importCodexDir (I/O + round-trip)", () => {
  it("imports the fixture tree, writes a validatable pack", async () => {
    const result = await importCodexDir(FIXTURE_DIR, OPTS);
    const manifestFile = result.files.find((f) => f.relativePath === "AGENTPACK.yaml")!;
    const parsedManifest = parseYaml(manifestFile.content);
    expect(() => agentPackManifestSchema.parse(parsedManifest)).not.toThrow();
    const validation = validateManifest(parsedManifest);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("emits skill bundled resources alongside SKILL.md", async () => {
    const result = await importCodexDir(FIXTURE_DIR, OPTS);
    const paths = result.files.map((f) => f.relativePath);
    expect(paths).toContain("atoms/skills/code-review/SKILL.md");
    expect(paths).toContain("atoms/skills/code-review/checklist.md");
    expect(paths).toContain("atoms/skills/code-review/references/runtime.md");
    expect(paths).toContain("atoms/skills/code-review/agents/openai.yaml");
  });

  it("warns and skips binary skill resources instead of corrupting them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-binary-skill-"));
    try {
      const skillDir = path.join(dir, ".agents/skills/demo");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: demo\ndescription: Demo skill.\n---\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(skillDir, "asset.bin"),
        Uint8Array.from([255, 0, 128, 65]),
      );

      const result = await importCodexDir(dir, { id: "acme.binary" });
      expect(result.files.some((file) => file.relativePath.endsWith("asset.bin"))).toBe(
        false,
      );
      expect(result.warnings).toContainEqual({
        line: 0,
        message:
          ".agents/skills/demo/asset.bin: Non-UTF-8 resource skipped; binary skill assets are not supported yet.",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips back out through the codex adapter with no semantic loss", async () => {
    const result = await importCodexDir(FIXTURE_DIR, OPTS);
    // Write the imported pack to a temp dir, then export it back to codex.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-roundtrip-"));
    try {
      for (const file of result.files) {
        const target = path.join(dir, file.relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content, "utf8");
      }
      const adapter = getAdapter("codex")!;
      const resolved = resolveAtoms({ manifest: result.manifest, profile: "all" });
      const out = await adapter.export({
        manifest: result.manifest,
        packRoot: dir,
        resolvedAtoms: resolved,
        profile: "all",
        target: "codex",
      });
      const outPaths = out.files.map((f) => f.path);
      // Skill survives the round trip.
      expect(outPaths).toContain(".agents/skills/code-review/SKILL.md");
      expect(outPaths).toContain(".agents/skills/code-review/references/runtime.md");
      expect(outPaths).toContain(".agents/skills/code-review/agents/openai.yaml");
      // MCP server survives into config.toml.
      const configToml = out.files.find((f) => f.path === ".codex/config.toml")!;
      const reparsed = parseToml(configToml.content) as {
        mcp_servers?: Record<string, unknown>;
      };
      expect(Object.keys(reparsed.mcp_servers ?? {})).toContain("github");
      // Subagent instructions survive, not only their display metadata.
      const subagentToml = out.files.find(
        (f) => f.path === ".codex/agents/security-reviewer.toml",
      )!;
      const reparsedSubagent = parseToml(subagentToml.content) as {
        developer_instructions?: string;
      };
      expect(reparsedSubagent.developer_instructions).toContain(
        "You are a security-focused code reviewer.",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("moves nested UTF-8 Codex skill resources to Claude Code unchanged", async () => {
    const result = await importCodexDir(FIXTURE_DIR, OPTS);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-to-claude-"));
    try {
      for (const file of result.files) {
        const target = path.join(dir, file.relativePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content, "utf8");
      }
      const adapter = getAdapter("claude-code")!;
      const resolved = resolveAtoms({ manifest: result.manifest, profile: "all" });
      const out = await adapter.export({
        manifest: result.manifest,
        packRoot: dir,
        resolvedAtoms: resolved,
        profile: "all",
        target: "claude-code",
      });
      const runtime = out.files.find(
        (f) => f.path === ".claude/skills/code-review/references/runtime.md",
      );
      const metadata = out.files.find(
        (f) => f.path === ".claude/skills/code-review/agents/openai.yaml",
      );
      expect(runtime?.content).toBe(
        "# Runtime Notes\n\nPreserve this nested reference across agent formats.\n",
      );
      expect(metadata?.content).toContain("display_name: Code Review");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is traversal-proof: refuses to write atoms outside the output dir", async () => {
    // A skill name crafted to traverse must not escape; importCodexDir
    // sanitizes slugs so the emitted relativePath stays inside the pack.
    const result = await importCodexDir(FIXTURE_DIR, OPTS);
    for (const file of result.files) {
      expect(path.isAbsolute(file.relativePath)).toBe(false);
      expect(file.relativePath.split(/[\\/]+/)).not.toContain("..");
    }
  });
});

async function readFixture() {
  const map = new Map<string, string>();
  async function walk(rel: string) {
    const abs = path.join(FIXTURE_DIR, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(childRel);
      else
        map.set(
          childRel.split(path.sep).join("/"),
          await fs.readFile(path.join(abs, e.name), "utf8"),
        );
    }
  }
  await walk("");
  return parseCodex(map);
}
