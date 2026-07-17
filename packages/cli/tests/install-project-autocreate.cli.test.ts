// #145: `install --project ./new-dir` must not fail with a circular error when
// the directory doesn't exist yet. Creating the directory is part of the write
// plan: it happens under --yes (or after the confirm prompt), never before
// consent, and NEVER under --dry-run. Genuinely uncreatable paths still error.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-project-autocreate-${Date.now()}`);

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

describe("install --project auto-create (#145)", () => {
  it("creates a nonexistent --project directory under --yes and installs into it", async () => {
    const cwd = path.join(TMP_ROOT, "fresh-cwd");
    await fs.mkdir(cwd, { recursive: true });
    const r = await run(
      [
        "install",
        EXAMPLE,
        "--target",
        "claude-code",
        "--profile",
        "safe",
        "--project",
        "./new-dir",
        "--yes",
      ],
      { cwd },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("will be created");
    expect(r.stdout).toContain("✓ Installed agentpack.pr-quality");
    const lock = await fs.stat(path.join(cwd, "new-dir", "AGENTPACK.lock"));
    expect(lock.isFile()).toBe(true);
    const claudeMd = await fs.stat(path.join(cwd, "new-dir", "CLAUDE.md"));
    expect(claudeMd.isFile()).toBe(true);
  });

  it("--dry-run with a nonexistent --project writes nothing, exits 0, and says so", async () => {
    const cwd = path.join(TMP_ROOT, "dry-run-cwd");
    await fs.mkdir(cwd, { recursive: true });
    const r = await run(
      [
        "install",
        EXAMPLE,
        "--target",
        "claude-code",
        "--profile",
        "safe",
        "--project",
        "./new-dir",
        "--dry-run",
      ],
      { cwd },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No files were written");
    expect(r.stdout).toContain("would create it");
    // The zero-mutation contract of --dry-run covers the directory itself.
    const created = await fs.stat(path.join(cwd, "new-dir")).catch(() => null);
    expect(created).toBeNull();
  });

  it("does not create the directory before consent (non-interactive, no --yes)", async () => {
    const cwd = path.join(TMP_ROOT, "no-consent-cwd");
    await fs.mkdir(cwd, { recursive: true });
    const r = await run(
      [
        "install",
        EXAMPLE,
        "--target",
        "claude-code",
        "--profile",
        "safe",
        "--project",
        "./new-dir",
      ],
      { cwd },
    );
    // Non-TTY stdin without --yes refuses at the confirmation step…
    expect(r.code).not.toBe(0);
    // …and the not-yet-consented directory must not exist.
    const created = await fs.stat(path.join(cwd, "new-dir")).catch(() => null);
    expect(created).toBeNull();
  });

  it("still errors cleanly on a genuinely uncreatable --project path", async () => {
    const cwd = path.join(TMP_ROOT, "uncreatable-cwd");
    await fs.mkdir(cwd, { recursive: true });
    // A path routed THROUGH a regular file can never be a directory.
    await fs.writeFile(path.join(cwd, "blocker"), "not a directory\n");
    const r = await run(
      [
        "install",
        EXAMPLE,
        "--target",
        "claude-code",
        "--profile",
        "safe",
        "--project",
        "./blocker/nested",
        "--yes",
      ],
      { cwd },
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Could not create project directory");
    // The old circular hint ("Pass --project…" when --project WAS passed)
    // must be gone from this path.
    expect(r.stderr).not.toContain("Pass --project to specify an existing directory");
  });
});
