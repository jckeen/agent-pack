// Issue #134: authored target compatibility is enforced at install time.
//
//   - `unsupported` target → refused before any writes (planner throws a
//     structured error; usage-error exit family, nothing lands on disk).
//   - `partial` / `experimental` target → requires the explicit
//     `--allow-partial-target` acknowledgement, mirroring --allow-critical /
//     --allow-exec: a bare -y (the non-interactive path) must fail CLOSED.
//   - Authored claim and compiler-observed fidelity are reported as two
//     separate fields in both the human plan summary and --json output.
//   - A target the manifest does NOT declare keeps installing exactly as
//     before — no new flag, no new friction.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const FIXTURES = path.resolve(__dirname, "fixtures");
const PARTIAL = path.join(FIXTURES, "partial-target");
const UNSUPPORTED = path.join(FIXTURES, "unsupported-target");
const UNDECLARED = path.join(FIXTURES, "undeclared-target");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-target-compat-cli-${Date.now()}`);

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

async function freshProject(name: string): Promise<string> {
  const dir = path.join(TMP_ROOT, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
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
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("install refuses an authored-unsupported target before any writes (AC1)", () => {
  it("exits non-zero with a structured message and writes nothing", async () => {
    const project = await freshProject("unsupported-refused");
    const res = await run([
      "install",
      UNSUPPORTED,
      "--target",
      "generic",
      "--project",
      project,
      "-y",
    ]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unsupported");
    expect(res.stderr).toContain("generic");
    // Nothing landed: no adapter output, no install state.
    expect(await pathExists(path.join(project, "AGENTS.md"))).toBe(false);
    expect(await pathExists(path.join(project, ".agentpack"))).toBe(false);
    expect(await pathExists(path.join(project, "AGENTPACK.lock"))).toBe(false);
    const entries = await fs.readdir(project);
    expect(entries).toEqual([]);
  });
});

describe("partial/experimental target requires --allow-partial-target (AC2)", () => {
  it("fails closed on a non-interactive install without the flag", async () => {
    const project = await freshProject("partial-refused");
    const res = await run([
      "install",
      PARTIAL,
      "--target",
      "generic",
      "--project",
      project,
      "-y",
    ]);
    expect(res.code).toBe(6); // ExitCode.PolicyViolation — same family as --allow-critical
    expect(res.stderr).toContain("--allow-partial-target");
    expect(await pathExists(path.join(project, "AGENTS.md"))).toBe(false);
    expect(await pathExists(path.join(project, ".agentpack"))).toBe(false);
  });

  it("emits a structured JSON refusal without the flag", async () => {
    const project = await freshProject("partial-refused-json");
    const res = await run([
      "install",
      PARTIAL,
      "--target",
      "generic",
      "--project",
      project,
      "-y",
      "--json",
    ]);
    expect(res.code).toBe(6);
    const payload = JSON.parse(res.stdout) as {
      installed: boolean;
      error: string;
      authoredCompatibility: string | null;
      observedFidelity: string;
    };
    expect(payload.installed).toBe(false);
    expect(payload.error).toBe("partial_target_refused");
    expect(payload.authoredCompatibility).toBe("partial");
    expect(typeof payload.observedFidelity).toBe("string");
  });

  it("installs when --allow-partial-target acknowledges the declaration", async () => {
    const project = await freshProject("partial-acknowledged");
    const res = await run([
      "install",
      PARTIAL,
      "--target",
      "generic",
      "--project",
      project,
      "-y",
      "--allow-partial-target",
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Installed");
    expect(await pathExists(path.join(project, "AGENTS.md"))).toBe(true);
    // The authored declaration still surfaces as a warning in the summary.
    expect(res.stdout.toLowerCase()).toContain("partial");
  });
});

describe("plan output reports authored claim and observed fidelity separately (AC5)", () => {
  it("shows both fields in the human plan summary (dry-run)", async () => {
    const project = await freshProject("partial-summary");
    const res = await run([
      "install",
      PARTIAL,
      "--target",
      "generic",
      "--project",
      project,
      "--dry-run",
      "-y",
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/authored[^\n]*partial/i);
    expect(res.stdout).toMatch(/observed[^\n]*(supported|partial)/i);
  });

  it("carries both fields in --json plan output", async () => {
    const project = await freshProject("partial-summary-json");
    const res = await run([
      "install",
      PARTIAL,
      "--target",
      "generic",
      "--project",
      project,
      "--dry-run",
      "-y",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      authoredCompatibility: string | null;
      observedFidelity: string;
    };
    expect(payload.authoredCompatibility).toBe("partial");
    expect(["supported", "partial", "experimental", "unsupported"]).toContain(
      payload.observedFidelity,
    );
  });
});

describe("undeclared targets keep installing with no new friction (backward compat)", () => {
  it("installs to a target the manifest does not declare, without any new flag", async () => {
    const project = await freshProject("undeclared-ok");
    const res = await run([
      "install",
      UNDECLARED,
      "--target",
      "generic",
      "--project",
      project,
      "-y",
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Installed");
    expect(res.stderr).not.toContain("--allow-partial-target");
    // The JSON surface reports the absence honestly: authored is null.
    const project2 = await freshProject("undeclared-ok-json");
    const res2 = await run([
      "install",
      UNDECLARED,
      "--target",
      "generic",
      "--project",
      project2,
      "--dry-run",
      "-y",
      "--json",
    ]);
    expect(res2.code).toBe(0);
    const payload = JSON.parse(res2.stdout) as {
      authoredCompatibility: string | null;
      observedFidelity: string;
    };
    expect(payload.authoredCompatibility).toBeNull();
    expect(typeof payload.observedFidelity).toBe("string");
  });
});
