// #148: install success output must orient the user in what they gained —
// atoms grouped by kind with names, then one line naming the runtime to open —
// before any plumbing (manifest paths, gitignore advice).
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-orientation-${Date.now()}`);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
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

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("install orientation block (#148)", () => {
  it("prints what landed, grouped by kind, then the runtime to open (snapshot)", async () => {
    const dir = await freshProject("safe");
    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "claude-code",
      "--profile",
      "safe",
      "--project",
      dir,
      "--yes",
    ]);
    expect(r.code).toBe(0);
    // Exact-block snapshot: success line, orientation, runtime line — in that
    // order, before any plumbing.
    const expected = [
      "✓ Installed agentpack.pr-quality@0.1.0 (claude-code, safe).",
      "",
      "You now have:",
      "  Commands: /pr-summary",
      "  Skills: code-review",
      "  CLAUDE.md: pr-review-standards, security-review-required (merged)",
      "Open this project in Claude Code to use them.",
      "",
    ].join("\n");
    expect(r.stdout).toContain(expected);
    // Plumbing follows the orientation block, never precedes it.
    expect(r.stdout.indexOf("You now have:")).toBeLessThan(
      r.stdout.indexOf("files + lockfile written"),
    );
  });

  it("only lists kinds that are present, and includes agents when installed", async () => {
    const dir = await freshProject("standard");
    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "claude-code",
      "--profile",
      "standard",
      "--project",
      dir,
      "--yes",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Agents: security-reviewer");
    // Kinds absent from the plan never print.
    expect(r.stdout).not.toContain("Hooks:");
    expect(r.stdout).not.toContain("MCP servers:");
  });

  it("names the target's runtime for non-claude targets", async () => {
    const dir = await freshProject("generic");
    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "generic",
      "--profile",
      "safe",
      "--project",
      dir,
      "--yes",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("You now have:");
    expect(r.stdout).toContain("Open this project in your agent runtime to use them.");
  });
});
