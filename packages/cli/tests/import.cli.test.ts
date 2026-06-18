import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-import-test-${Date.now()}`);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(
  args: string[],
  options: { cwd?: string; stdin?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_ENTRY, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

const FIXTURE = [
  "---",
  "title: ignore me",
  "---",
  "# Team Defaults",
  "",
  "## Working Style",
  "",
  "Plan before non-trivial work.",
  "",
  "## Git",
  "",
  "- Commit only when asked.",
  "- Never force-push to shared branches.",
  "",
  "## External Reference",
  "",
  "@~/dev/other/CLAUDE.md",
  "",
  "Keep this body.",
].join("\n");

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("agentpack import", () => {
  it("imports a fixture and the output validates with exit 0", async () => {
    const fixturePath = path.join(TMP_ROOT, "CLAUDE.md");
    const outDir = path.join(TMP_ROOT, "out");
    await fs.writeFile(fixturePath, FIXTURE, "utf8");

    const imp = await run([
      "import",
      fixturePath,
      "--out",
      outDir,
      "--id",
      "acme.team-defaults",
      "--name",
      "Team Defaults",
    ]);
    expect(imp.code).toBe(0);
    // @import directive surfaced as a warning.
    expect(imp.stdout + imp.stderr).toContain("@import");

    // Manifest + atom files exist.
    await fs.access(path.join(outDir, "AGENTPACK.yaml"));
    await fs.access(path.join(outDir, "atoms/rules/git.yaml"));
    await fs.access(path.join(outDir, "atoms/instructions/working-style.md"));

    const validate = await run(["validate", outDir]);
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("✓ Manifest is valid.");
  });

  it("reads from stdin when path is `-`", async () => {
    const outDir = path.join(TMP_ROOT, "out-stdin");
    const imp = await run(["import", "-", "--out", outDir, "--id", "acme.from-stdin"], {
      stdin: "## Working Style\n\nbody\n",
    });
    expect(imp.code).toBe(0);
    const validate = await run(["validate", outDir]);
    expect(validate.code).toBe(0);
  });

  it("exits 2 when --id is missing", async () => {
    const fixturePath = path.join(TMP_ROOT, "CLAUDE.md");
    const r = await run(["import", fixturePath, "--out", path.join(TMP_ROOT, "x")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--id");
  });

  it("exits 2 when --id is malformed", async () => {
    const fixturePath = path.join(TMP_ROOT, "CLAUDE.md");
    const r = await run([
      "import",
      fixturePath,
      "--out",
      path.join(TMP_ROOT, "y"),
      "--id",
      "nodot",
    ]);
    expect(r.code).toBe(2);
  });

  it("exits 2 when --from is unknown", async () => {
    const r = await run([
      "import",
      TMP_ROOT,
      "--from",
      "bogus",
      "--id",
      "acme.team",
      "--out",
      path.join(TMP_ROOT, "z"),
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--from");
  });

  it("imports a Codex setup directory with --from codex and validates", async () => {
    const codexFixture = path.resolve(__dirname, "../../core/tests/fixtures/codex");
    const outDir = path.join(TMP_ROOT, "out-codex");
    const imp = await run([
      "import",
      codexFixture,
      "--from",
      "codex",
      "--out",
      outDir,
      "--id",
      "acme.codex",
      "--name",
      "Acme Codex",
    ]);
    expect(imp.code).toBe(0);

    // Manifest + Codex-native atom files exist.
    await fs.access(path.join(outDir, "AGENTPACK.yaml"));
    await fs.access(path.join(outDir, "atoms/skills/code-review/SKILL.md"));
    await fs.access(path.join(outDir, "atoms/mcp/github.yaml"));

    const validate = await run(["validate", outDir]);
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("✓ Manifest is valid.");
  });

  it("imports a Claude Code config directory with --from claude-code and validates", async () => {
    const ccFixture = path.resolve(__dirname, "../../core/tests/fixtures/claude-code");
    const outDir = path.join(TMP_ROOT, "out-claude-code");
    const imp = await run([
      "import",
      ccFixture,
      "--from",
      "claude-code",
      "--out",
      outDir,
      "--id",
      "keen.workstation",
      "--name",
      "Keen Workstation",
    ]);
    expect(imp.code).toBe(0);

    // Manifest + native atom files across multiple atom types exist.
    await fs.access(path.join(outDir, "AGENTPACK.yaml"));
    await fs.access(path.join(outDir, "atoms/skills/code-review/SKILL.md"));
    await fs.access(path.join(outDir, "atoms/subagents/security-reviewer.yaml"));

    const validate = await run(["validate", outDir]);
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("✓ Manifest is valid.");

    // The credential store is never packaged.
    await expect(fs.access(path.join(outDir, ".credentials.json"))).rejects.toThrow();
  });

  it("imports a ChatGPT-GPT bundle with --from chatgpt-gpt and validates", async () => {
    const bundle = path.resolve(__dirname, "../../core/tests/fixtures/chatgpt");
    const outDir = path.join(TMP_ROOT, "out-chatgpt");
    const imp = await run([
      "import",
      bundle,
      "--from",
      "chatgpt-gpt",
      "--out",
      outDir,
      "--id",
      "acme.support-triage",
      "--name",
      "Support Triage",
    ]);
    expect(imp.code).toBe(0);
    // Honest can't-cross + human-judgment guidance is surfaced.
    expect(imp.stdout).toContain("Human-judgment steps");
    expect(imp.stdout).toContain("managed vector-store retrieval");

    await fs.access(path.join(outDir, "AGENTPACK.yaml"));
    await fs.access(path.join(outDir, "atoms/context/knowledge/refund-policy.md"));

    const validate = await run(["validate", outDir]);
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("✓ Manifest is valid.");
  });
});
