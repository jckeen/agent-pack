import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-cli-test-${Date.now()}`);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_ENTRY, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: {
        ...process.env,
        ...options.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("agentpack CLI — invocation", () => {
  it("--version returns 0.2.0 and exits 0", async () => {
    const r = await run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("0.2.0");
  });

  it("--help lists every command", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    for (const cmd of [
      "init",
      "validate",
      "inspect",
      "plan",
      "pack",
      "doctor",
    ]) {
      expect(r.stdout).toContain(cmd);
    }
  });
});

describe("agentpack validate", () => {
  it("validates the example pack successfully", async () => {
    const r = await run(["validate", EXAMPLE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ Manifest is valid.");
  });

  it("exits non-zero on a broken manifest", async () => {
    const broken = path.join(TMP_ROOT, "broken-pack");
    await fs.mkdir(broken, { recursive: true });
    await fs.writeFile(
      path.join(broken, "AGENTPACK.yaml"),
      "agentpack: \"1.0\"\n# missing everything else\n",
      "utf8",
    );
    const r = await run(["validate", broken]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/invalid|error/i);
  });

  it("errors with a clear message when the path does not exist", async () => {
    const r = await run(["validate", path.join(TMP_ROOT, "does-not-exist")]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/Could not access|ENOENT|no such file/i);
  });
});

describe("agentpack inspect", () => {
  it("prints metadata, compatibility, profiles, atoms, and risk preview", async () => {
    const r = await run(["inspect", EXAMPLE]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Pull Request Quality Pack");
    expect(r.stdout).toContain("agentpack.pr-quality");
    expect(r.stdout).toContain("Compatibility");
    expect(r.stdout).toContain("Profiles");
    expect(r.stdout).toContain("Atoms (7)");
    expect(r.stdout).toContain("Preview for profile `safe`");
  });

  it("supports --profile to switch the preview", async () => {
    const r = await run(["inspect", EXAMPLE, "--profile", "standard"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Preview for profile `standard`");
  });
});

describe("agentpack plan", () => {
  it("plan --profile safe reports LOW risk and 4 atoms", async () => {
    const r = await run(["plan", EXAMPLE, "--target", "claude-code", "--profile", "safe"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/LOW/);
    expect(r.stdout).toContain("Atoms (4)");
    // hooks and MCP excluded
    expect(r.stdout).not.toContain("hook:post-edit-format");
    expect(r.stdout).not.toContain("mcp_server:github");
  });

  it("plan --profile full surfaces the four required warnings (hook, shell, MCP, GITHUB_TOKEN)", async () => {
    const r = await run(["plan", EXAMPLE, "--target", "claude-code", "--profile", "full"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/hook:post-edit-format/);
    expect(r.stdout).toMatch(/shell\.execution|shell commands/i);
    expect(r.stdout).toMatch(/mcp_server:github|GitHub MCP/);
    expect(r.stdout).toMatch(/GITHUB_TOKEN/);
  });

  it("plan rejects an unknown --target with exit 2", async () => {
    const r = await run([
      "plan",
      EXAMPLE,
      "--target",
      "neopets",
      "--profile",
      "safe",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/Invalid --target/);
  });

  it("plan --only narrows the atom set", async () => {
    const r = await run([
      "plan",
      EXAMPLE,
      "--target",
      "generic",
      "--profile",
      "full",
      "--only",
      "instruction:pr-review-standards,rule:security-review-required",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Atoms (2)");
  });
});

describe("agentpack pack export", () => {
  it("writes the documented files for every target", async () => {
    const targets = ["claude-code", "codex", "cursor", "chatgpt", "generic"];
    const expected: Record<string, string[]> = {
      "claude-code": ["CLAUDE.md", ".claude/skills/code-review/SKILL.md"],
      codex: ["AGENTS.md", ".codex/config.toml"],
      cursor: ["AGENTS.md", ".cursor/rules/security-review-required.mdc"],
      chatgpt: ["project-instructions.md", "app-manifest.json"],
      generic: ["AGENTS.md", "skills/code-review/SKILL.md", "agentpack.json"],
    };
    for (const target of targets) {
      const out = path.join(TMP_ROOT, `export-${target}`);
      const r = await run([
        "pack",
        "export",
        EXAMPLE,
        "--target",
        target,
        "--profile",
        "safe",
        "--out",
        out,
      ]);
      expect(r.code).toBe(0);
      for (const rel of expected[target] ?? []) {
        await expect(fs.access(path.join(out, rel))).resolves.toBeUndefined();
      }
    }
  });

  it("writes hooks to settings.json and MCP servers to .mcp.json for claude-code full profile", async () => {
    const out = path.join(TMP_ROOT, "export-claude-full");
    const r = await run([
      "pack",
      "export",
      EXAMPLE,
      "--target",
      "claude-code",
      "--profile",
      "full",
      "--out",
      out,
    ]);
    expect(r.code).toBe(0);
    const settings = JSON.parse(
      await fs.readFile(path.join(out, ".claude/settings.json"), "utf8"),
    );
    expect(settings).toHaveProperty("hooks");
    expect(settings).not.toHaveProperty("mcpServers");
    const mcp = JSON.parse(await fs.readFile(path.join(out, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers).toHaveProperty("github");
  });

  it("rejects unknown --target with exit 2 and does not create outDir", async () => {
    const out = path.join(TMP_ROOT, "export-bad-target");
    const r = await run([
      "pack",
      "export",
      EXAMPLE,
      "--target",
      "neopets",
      "--out",
      out,
    ]);
    expect(r.code).toBe(2);
    await expect(fs.access(out)).rejects.toThrow();
  });
});

describe("agentpack init", () => {
  it("creates AGENTPACK.yaml and example atoms in the current directory", async () => {
    const cwd = path.join(TMP_ROOT, "init-target");
    await fs.mkdir(cwd, { recursive: true });
    const r = await run(["init"], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("AGENTPACK.yaml");
    await expect(
      fs.access(path.join(cwd, "AGENTPACK.yaml")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(cwd, "atoms/instructions/project-defaults.md"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(cwd, "atoms/skills/example-skill/SKILL.md")),
    ).resolves.toBeUndefined();
  });

  it("does not overwrite an existing AGENTPACK.yaml without --force", async () => {
    const cwd = path.join(TMP_ROOT, "init-existing");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(
      path.join(cwd, "AGENTPACK.yaml"),
      "# existing\n",
      "utf8",
    );
    const r = await run(["init"], { cwd });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/skipping/i);
    const body = await fs.readFile(path.join(cwd, "AGENTPACK.yaml"), "utf8");
    expect(body).toBe("# existing\n");
  });

  it("overwrites with --force", async () => {
    const cwd = path.join(TMP_ROOT, "init-force");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(
      path.join(cwd, "AGENTPACK.yaml"),
      "# existing\n",
      "utf8",
    );
    const r = await run(["init", "--force"], { cwd });
    expect(r.code).toBe(0);
    const body = await fs.readFile(path.join(cwd, "AGENTPACK.yaml"), "utf8");
    expect(body).toMatch(/agentpack: "1\.0"/);
  });
});

describe("agentpack doctor", () => {
  it("reports node, pnpm, npm, git availability", async () => {
    const r = await run(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/node ≥ 18/);
    expect(r.stdout).toMatch(/pnpm available/);
    expect(r.stdout).toMatch(/npm available/);
    expect(r.stdout).toMatch(/git available/);
  });
});
