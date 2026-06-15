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
});
