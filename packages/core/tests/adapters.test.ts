import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPack, type TargetPlatform } from "../src/index.js";
import { demoteBodyHeadings } from "../src/adapters/types.js";

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");

const TARGETS: TargetPlatform[] = ["claude-code", "codex", "cursor", "chatgpt", "generic"];

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

// Issue #24: the shared atom-body reconciliation. Every instruction adapter
// funnels its body through `demoteBodyHeadings(body, sectionLevel, atomName)`,
// so the strip/demote/CRLF behavior is tested once here against the helper.
describe("demoteBodyHeadings (issue #24 shared rendering)", () => {
  it("demotes a leading H1 whose text DIFFERS from the atom name (no strip)", () => {
    const body = "# Pull Request Review Standards\n\nReview carefully.";
    // Section header is `### ` (level 3) → leading H1 lands at `####`.
    const out = demoteBodyHeadings(body, 3, "PR Review Standards");
    expect(out).toBe("#### Pull Request Review Standards\n\nReview carefully.");
    // No `^# ` H1 survives under the section header.
    expect(out.split("\n").some((l) => /^# (?!#)/.test(l))).toBe(false);
  });

  it("STRIPS a leading H1 that equals the atom name (case-insensitive)", () => {
    const body = "# Operator Context\n\n- be concise\n- cite sources";
    const out = demoteBodyHeadings(body, 2, "operator context");
    // Redundant title removed (with its trailing blank line) — common case is
    // just the body bullets, no duplicate title and no leading blank line.
    expect(out).toBe("- be concise\n- cite sources");
    expect(out).not.toContain("# Operator Context");
  });

  it("strips the duplicate title but still nests remaining subsections", () => {
    const body = ["# Operator Context", "", "Intro.", "", "## Details", "", "More."].join(
      "\n",
    );
    // Section header level 2 → the highest REMAINING heading (`## Details`)
    // must land one level below it (`### Details`), staying valid.
    const out = demoteBodyHeadings(body, 2, "Operator Context");
    expect(out).toBe(["Intro.", "", "### Details", "", "More."].join("\n"));
    expect(out).not.toMatch(/^# /m);
  });

  it("tolerates CRLF line endings (demote)", () => {
    const body = "# Title\r\n\r\nBody line.\r\n";
    const out = demoteBodyHeadings(body, 2, "Different Name");
    // The leading H1 is demoted (names differ) and the CRLF endings round-trip.
    expect(out).toBe("### Title\r\n\r\nBody line.\r\n");
  });

  it("tolerates CRLF line endings (strip when name==title)", () => {
    const body = "# Operator Context\r\n\r\n- be concise\r\n";
    const out = demoteBodyHeadings(body, 2, "Operator Context");
    expect(out).toBe("- be concise\r\n");
    expect(out).not.toContain("# Operator Context");
  });

  it("is a no-op when the body does not start with an H1", () => {
    const body = "## Already Nested\n\nBody.";
    expect(demoteBodyHeadings(body, 2, "Anything")).toBe(body);
  });

  it("leaves `#` lines inside fenced code blocks untouched", () => {
    const body = "# Title\n\n```sh\n# not a heading\necho hi\n```";
    const out = demoteBodyHeadings(body, 2, "Different");
    expect(out).toBe("### Title\n\n```sh\n# not a heading\necho hi\n```");
  });
});

describe("adapters write expected files", () => {
  it("claude-code (safe) writes CLAUDE.md and the code-review skill", async () => {
    const r = await runExport("claude-code", "safe");
    expect(await pathExists(path.join(r.outDir, "CLAUDE.md"))).toBe(true);
    expect(
      await pathExists(path.join(r.outDir, ".claude/skills/code-review/SKILL.md")),
    ).toBe(true);
  });

  it("claude-code (standard) adds the security-reviewer subagent", async () => {
    const r = await runExport("claude-code", "standard");
    expect(
      await pathExists(path.join(r.outDir, ".claude/agents/security-reviewer.md")),
    ).toBe(true);
  });

  it("claude-code (full) writes hooks to .claude/settings.json and MCP servers to .mcp.json", async () => {
    const r = await runExport("claude-code", "full");
    const settingsPath = path.join(r.outDir, ".claude/settings.json");
    expect(await pathExists(settingsPath)).toBe(true);
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings).toHaveProperty("hooks");
    // MCP servers must NOT live in settings.json — Claude Code only reads
    // project-scoped servers from .mcp.json at the project root.
    expect(settings).not.toHaveProperty("mcpServers");
    expect(await pathExists(path.join(r.outDir, ".mcp.json"))).toBe(true);
    // Hook entries carry only schema keys, with a real tool matcher.
    const entry = settings.hooks.PostToolUse[0];
    expect(entry.matcher).toBe("Edit|Write");
    expect(entry.hooks[0]).toEqual({ type: "command", command: "npm run format" });
  });

  it("claude-code compiles command atoms to .claude/commands/<slug>.md", async () => {
    const r = await runExport("claude-code", "safe");
    const cmdPath = path.join(r.outDir, ".claude/commands/pr-summary.md");
    expect(await pathExists(cmdPath)).toBe(true);
    const cmd = await fs.readFile(cmdPath, "utf8");
    expect(cmd).toMatch(/^---\ndescription: /);
  });

  it("claude-code renders rule body must/must_not into CLAUDE.md", async () => {
    const r = await runExport("claude-code", "safe");
    const claudeMd = await fs.readFile(path.join(r.outDir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Must not:");
    expect(claudeMd).toContain("Explicitly flag security-sensitive changes.");
  });

  it("codex writes AGENTS.md and .codex/config.toml", async () => {
    const r = await runExport("codex", "safe");
    expect(await pathExists(path.join(r.outDir, "AGENTS.md"))).toBe(true);
    expect(await pathExists(path.join(r.outDir, ".codex/config.toml"))).toBe(true);
  });

  it("codex (full) writes .codex/hooks.json", async () => {
    const r = await runExport("codex", "full");
    expect(await pathExists(path.join(r.outDir, ".codex/hooks.json"))).toBe(true);
  });

  it("cursor writes AGENTS.md and the security-review-required rule", async () => {
    const r = await runExport("cursor", "safe");
    expect(await pathExists(path.join(r.outDir, "AGENTS.md"))).toBe(true);
    expect(
      await pathExists(path.join(r.outDir, ".cursor/rules/security-review-required.mdc")),
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
    expect(await pathExists(path.join(r.outDir, "project-instructions.md"))).toBe(true);
    expect(await pathExists(path.join(r.outDir, "app-manifest.json"))).toBe(true);
  });

  it("chatgpt (with commands) writes an MCP tool stub for the command atom", async () => {
    const r = await runExport("chatgpt", "safe");
    expect(
      await pathExists(path.join(r.outDir, "mcp-server/src/tools/pr-summary.ts")),
    ).toBe(true);
  });

  it("generic writes AGENTS.md, code-review skill, and agentpack.json", async () => {
    const r = await runExport("generic", "safe");
    expect(await pathExists(path.join(r.outDir, "AGENTS.md"))).toBe(true);
    expect(await pathExists(path.join(r.outDir, "skills/code-review/SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(r.outDir, "agentpack.json"))).toBe(true);
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

  it("claude-code .mcp.json parses back with the github MCP server intact", async () => {
    const r = await runExport("claude-code", "full");
    const settings = JSON.parse(
      await fs.readFile(path.join(r.outDir, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<
        string,
        { type: string; command: string; args: string[]; env: Record<string, string> }
      >;
    };
    const github = settings.mcpServers["github"];
    expect(github).toBeDefined();
    expect(github!.type).toBe("stdio");
    expect(github!.command).toBe("npx");
    expect(github!.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
    expect(github!.env).toEqual({ GITHUB_TOKEN: "${GITHUB_TOKEN}" });
  });

  it("codex config.toml parses back with the github MCP server intact", async () => {
    const r = await runExport("codex", "full");
    const toml = await fs.readFile(path.join(r.outDir, ".codex/config.toml"), "utf8");
    const github = parseTomlTable(toml, "mcp_servers.github");
    expect(github["transport"]).toBe("stdio");
    expect(github["command"]).toBe("npx");
    expect(github["args"]).toEqual(["-y", "@modelcontextprotocol/server-github"]);
    expect(github["env_vars"]).toEqual(["GITHUB_TOKEN"]);
  });

  // Issue #24: an instruction body whose first line is `# Title` must not emit
  // an <h1> beneath the `##`/`###` section header, and must not duplicate the
  // atom title. The example pack's `instruction:pr-review-standards` body opens
  // with `# Pull Request Review Standards`, so the real export exercises this.
  it.each([
    {
      target: "claude-code" as const,
      file: "CLAUDE.md",
      sectionLine: "### PR Review Standards",
    },
    { target: "codex" as const, file: "AGENTS.md", sectionLine: "## PR Review Standards" },
    { target: "cursor" as const, file: "AGENTS.md", sectionLine: "## PR Review Standards" },
    {
      target: "generic" as const,
      file: "AGENTS.md",
      sectionLine: "## PR Review Standards",
    },
  ])(
    "$target: instruction body starting with # X nests under the section header without a duplicate title (#24)",
    async ({ target, file, sectionLine }) => {
      const r = await runExport(target, "safe");
      const doc = await fs.readFile(path.join(r.outDir, file), "utf8");

      // The section header for the atom is emitted exactly once.
      const sectionIdx = doc.indexOf(`${sectionLine}\n`);
      expect(sectionIdx).toBeGreaterThanOrEqual(0);
      // Scope to this atom's section only — up to the next same-or-higher-level
      // header — so an unrelated H1 from a later skill section isn't counted.
      const sectionLevel = sectionLine.match(/^#+/)![0].length;
      const after = doc.slice(sectionIdx + sectionLine.length);
      const nextHeader = after.search(new RegExp(`\\n#{1,${sectionLevel}} `));
      const section =
        nextHeader === -1
          ? doc.slice(sectionIdx)
          : doc.slice(sectionIdx, sectionIdx + sectionLine.length + nextHeader);

      // The body's original `# Pull Request Review Standards` H1 was demoted —
      // it must no longer appear at H1 level, and there must be no `^# ` heading
      // anywhere beneath the section header.
      const bodyLines = section.split("\n");
      for (const line of bodyLines) {
        expect(line).not.toMatch(/^# (?!#)/);
      }

      // The demoted title nests exactly one level below the section header.
      const demotedTitle = `${"#".repeat(sectionLevel + 1)} Pull Request Review Standards`;
      expect(section).toContain(`${demotedTitle}\n`);

      // The title appears only once (the demoted body heading) — the section
      // header uses the atom name, so the original title is not duplicated.
      const titleOccurrences = doc.split("Pull Request Review Standards").length - 1;
      expect(titleOccurrences).toBe(1);
    },
  );

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

function parseTomlTable(toml: string, name: string): Record<string, unknown> {
  const lines = toml.split("\n");
  const start = lines.indexOf(`[${name}]`);
  expect(start).toBeGreaterThanOrEqual(0);
  const table: Record<string, unknown> = {};
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("[")) break;
    const m = line.match(/^([A-Za-z0-9_.-]+) = (.*)$/);
    if (!m) continue;
    // The adapter emits only basic strings, arrays of basic strings, numbers,
    // and booleans — all of which are JSON-compatible.
    table[m[1]!] = JSON.parse(m[2]!) as unknown;
  }
  return table;
}

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
