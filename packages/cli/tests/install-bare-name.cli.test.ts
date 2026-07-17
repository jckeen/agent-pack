// #147: `agentpack install pr-quality` (npm-conditioned bare name) must not
// surface a raw ENOENT. A source arg with no path separator, no scheme, and
// nothing on disk gets a guided error naming the three expected source forms.
// Real paths — relative, ./-prefixed, or a bare name that actually exists on
// disk — keep working unchanged.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-bare-name-${Date.now()}`);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(args: string[], options: { cwd?: string } = {}): Promise<RunResult> {
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
  });
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("install <bare-name> guided error (#147)", () => {
  it("explains the three source forms instead of raw ENOENT", async () => {
    const cwd = path.join(TMP_ROOT, "empty-cwd");
    await fs.mkdir(cwd, { recursive: true });
    const r = await run(["install", "pr-quality"], { cwd });
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain("ENOENT");
    // One example per expected form.
    expect(r.stderr).toContain("local pack path");
    expect(r.stderr).toContain("./examples/pr-quality");
    expect(r.stderr).toContain("git source");
    expect(r.stderr).toContain("github:jckeen/agent-pack@master#examples/pr-quality");
    expect(r.stderr).toContain("registry id");
    expect(r.stderr).toContain("agentpack/pr-quality");
  });

  it("a relative path with a separator still works (examples/pr-quality)", async () => {
    const dir = path.join(TMP_ROOT, "rel-path");
    await fs.mkdir(dir, { recursive: true });
    const r = await run([
      "install",
      "examples/pr-quality",
      "--target",
      "claude-code",
      "--profile",
      "safe",
      "--project",
      dir,
      "--dry-run",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Install plan: agentpack.pr-quality");
  });

  it("a ./-prefixed path still works (./examples/pr-quality)", async () => {
    const dir = path.join(TMP_ROOT, "dot-path");
    await fs.mkdir(dir, { recursive: true });
    const r = await run([
      "install",
      "./examples/pr-quality",
      "--target",
      "claude-code",
      "--profile",
      "safe",
      "--project",
      dir,
      "--dry-run",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Install plan: agentpack.pr-quality");
  });

  it("a bare name that exists as a directory installs as a local path", async () => {
    const cwd = path.join(TMP_ROOT, "bare-exists");
    await fs.mkdir(cwd, { recursive: true });
    await fs.cp(EXAMPLE, path.join(cwd, "pr-quality"), { recursive: true });
    const dir = path.join(TMP_ROOT, "bare-exists-project");
    await fs.mkdir(dir, { recursive: true });
    const r = await run(
      [
        "install",
        "pr-quality",
        "--target",
        "claude-code",
        "--profile",
        "safe",
        "--project",
        dir,
        "--dry-run",
      ],
      { cwd },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Install plan: agentpack.pr-quality");
  });
});
