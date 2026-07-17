import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-dryrun-recovery-cli-${Date.now()}`);

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

/** Every file under `root` (project-relative POSIX path) → sha256 of bytes. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, nextRel);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(abs);
        snapshot.set(nextRel, createHash("sha256").update(bytes).digest("hex"));
      }
    }
  }
  await walk(root, "");
  return snapshot;
}

/**
 * Simulate a crash between file writes and the commit row: drop the trailing
 * `install_commit` from history.jsonl, leaving a dangling `install_begin`.
 * The forward hash chain stays valid because only the tail is removed.
 */
async function dropLastHistoryEntry(projectRoot: string): Promise<void> {
  const historyFile = path.join(projectRoot, ".agentpack", "history.jsonl");
  const raw = await fs.readFile(historyFile, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  lines.pop();
  await fs.writeFile(historyFile, lines.join("\n") + "\n", "utf8");
}

async function seedIncompleteInstall(name: string): Promise<string> {
  const dir = path.join(TMP_ROOT, name);
  await fs.mkdir(dir, { recursive: true });
  const installed = await run([
    "install",
    EXAMPLE,
    "--target",
    "generic",
    "--profile",
    "safe",
    "--project",
    dir,
    "-y",
  ]);
  expect(installed.code).toBe(0);
  await dropLastHistoryEntry(dir);
  return dir;
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("install --dry-run with pending crash recovery (#123)", () => {
  it("mutates nothing — the tree is byte-identical before and after", async () => {
    const dir = await seedIncompleteInstall("zero-mutation");
    const before = await snapshotTree(dir);

    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "generic",
      "--profile",
      "safe",
      "--project",
      dir,
      "--dry-run",
    ]);
    expect(r.code).toBe(0);

    const after = await snapshotTree(dir);
    expect(Object.fromEntries(after)).toEqual(Object.fromEntries(before));

    // The skipped recovery is surfaced as a warning, not silently ignored.
    expect(r.stdout + r.stderr).toMatch(/pending crash recovery/i);
  });

  it("reports the pending count in --json dry-run output", async () => {
    const dir = await seedIncompleteInstall("json-pending");
    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "generic",
      "--profile",
      "safe",
      "--project",
      dir,
      "--dry-run",
      "--json",
    ]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as { dryRun: boolean; pendingRecovery: number };
    expect(payload.dryRun).toBe(true);
    expect(payload.pendingRecovery).toBe(1);
  });

  it("a real install still runs the recovery sweep", async () => {
    const dir = await seedIncompleteInstall("real-install-recovers");
    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "generic",
      "--profile",
      "safe",
      "--project",
      dir,
      "-y",
    ]);
    expect(r.code).toBe(0);
    const history = await fs.readFile(
      path.join(dir, ".agentpack", "history.jsonl"),
      "utf8",
    );
    // The sweep rolled the dangling begin forward before the new install.
    expect(history).toContain('"recoveredBegin"');
  });
});
