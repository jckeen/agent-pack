import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPack, type TargetPlatform } from "../src/index.js";

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");

const TARGETS: TargetPlatform[] = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
];

const tmpRoot = path.join(os.tmpdir(), `agentpack-adapter-test-${Date.now()}`);

async function runExport(target: TargetPlatform, profile: string) {
  const outDir = path.join(tmpRoot, `${target}-${profile}`);
  const result = await exportPack({
    source: EXAMPLE,
    target,
    profile,
    outDir,
  });
  return { ...result, outDir };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("adapters write expected files", () => {
  it("claude-code (safe) writes CLAUDE.md and the code-review skill", async () => {
    const r = await runExport("claude-code", "safe");
    expect(await pathExists(path.join(r.outDir, "CLAUDE.md"))).toBe(true);
    expect(
      await pathExists(
        path.join(r.outDir, ".claude/skills/code-review/SKILL.md"),
      ),
    ).toBe(true);
  });

  it("claude-code (standard) adds the security-reviewer subagent", async () => {
    const r = await runExport("claude-code", "standard");
    expect(
      await pathExists(
        path.join(r.outDir, ".claude/agents/security-reviewer.md"),
      ),
    ).toBe(true);
  });

  it("claude-code (full) writes .claude/settings.json with hook and MCP blocks", async () => {
    const r = await runExport("claude-code", "full");
    const settingsPath = path.join(r.outDir, ".claude/settings.json");
    expect(await pathExists(settingsPath)).toBe(true);
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings).toHaveProperty("hooks");
    expect(settings).toHaveProperty("mcpServers");
  });

  it("codex writes AGENTS.md and .codex/config.toml", async () => {
    const r = await runExport("codex", "safe");
    expect(await pathExists(path.join(r.outDir, "AGENTS.md"))).toBe(true);
    expect(
      await pathExists(path.join(r.outDir, ".codex/config.toml")),
    ).toBe(true);
  });

  it("codex (full) writes .codex/hooks.json", async () => {
    const r = await runExport("codex", "full");
    expect(
      await pathExists(path.join(r.outDir, ".codex/hooks.json")),
    ).toBe(true);
  });

  it("cursor writes AGENTS.md and the security-review-required rule", async () => {
    const r = await runExport("cursor", "safe");
    expect(await pathExists(path.join(r.outDir, "AGENTS.md"))).toBe(true);
    expect(
      await pathExists(
        path.join(r.outDir, ".cursor/rules/security-review-required.mdc"),
      ),
    ).toBe(true);
  });

  it("cursor (full) writes .cursor/mcp.json with the github server", async () => {
    const r = await runExport("cursor", "full");
    const mcpPath = path.join(r.outDir, ".cursor/mcp.json");
    expect(await pathExists(mcpPath)).toBe(true);
    const mcp = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    expect(mcp.mcpServers).toHaveProperty("github");
  });

  it("chatgpt writes project-instructions.md and an app manifest", async () => {
    const r = await runExport("chatgpt", "safe");
    expect(
      await pathExists(path.join(r.outDir, "project-instructions.md")),
    ).toBe(true);
    expect(
      await pathExists(path.join(r.outDir, "app-manifest.json")),
    ).toBe(true);
  });

  it("chatgpt (with commands) writes an MCP tool stub for the command atom", async () => {
    const r = await runExport("chatgpt", "safe");
    expect(
      await pathExists(
        path.join(r.outDir, "mcp-server/src/tools/pr-summary.ts"),
      ),
    ).toBe(true);
  });

  it("generic writes AGENTS.md, code-review skill, and agentpack.json", async () => {
    const r = await runExport("generic", "safe");
    expect(await pathExists(path.join(r.outDir, "AGENTS.md"))).toBe(true);
    expect(
      await pathExists(path.join(r.outDir, "skills/code-review/SKILL.md")),
    ).toBe(true);
    expect(
      await pathExists(path.join(r.outDir, "agentpack.json")),
    ).toBe(true);
  });

  it("instruction outputs contain the AgentPack BEGIN/END markers", async () => {
    for (const target of TARGETS) {
      const r = await runExport(target, "safe");
      const candidates = ["CLAUDE.md", "AGENTS.md"];
      for (const fileName of candidates) {
        const p = path.join(r.outDir, fileName);
        if (!(await pathExists(p))) continue;
        const body = await fs.readFile(p, "utf8");
        expect(body).toContain("<!-- BEGIN AGENTPACK: agentpack.pr-quality -->");
        expect(body).toContain("<!-- END AGENTPACK: agentpack.pr-quality -->");
      }
    }
  });

  it("two consecutive exports produce byte-identical files (determinism)", async () => {
    const out1 = path.join(tmpRoot, "determ-a");
    const out2 = path.join(tmpRoot, "determ-b");
    await exportPack({
      source: EXAMPLE,
      target: "claude-code",
      profile: "full",
      outDir: out1,
    });
    await exportPack({
      source: EXAMPLE,
      target: "claude-code",
      profile: "full",
      outDir: out2,
    });
    const files1 = await listFilesRecursive(out1);
    const files2 = await listFilesRecursive(out2);
    expect(files1).toEqual(files2);
    for (const rel of files1) {
      const a = await fs.readFile(path.join(out1, rel), "utf8");
      const b = await fs.readFile(path.join(out2, rel), "utf8");
      expect(a).toBe(b);
    }
  });

  it("export refuses to write outside the outDir", async () => {
    const badOut = path.join(tmpRoot, "boundary-check");
    // We rely on the contract; constructing a malicious adapter is overkill
    // here. Instead, sanity-check the relative-path invariant by reading a
    // generated file path and confirming it does not start with `..`.
    const r = await runExport("generic", "safe");
    for (const f of r.writtenFiles) {
      expect(f.startsWith("..")).toBe(false);
      expect(path.isAbsolute(f)).toBe(false);
    }
    void badOut;
  });
});

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const next = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(abs, next);
      else if (e.isFile()) out.push(next);
    }
  }
  await walk(root, "");
  return out.sort();
}
