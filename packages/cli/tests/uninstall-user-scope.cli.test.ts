// #146: `uninstall --scope user` — the exit door for `install --scope user`.
// Same project→~/.claude mapping install/update use. The regression test runs
// against a throwaway HOME: after install → uninstall, every pre-existing file
// is byte-identical and every pack payload file is gone; the only additions
// are the deliberately-retained audit artifacts (~/.claude/.agentpack/** and
// ~/.claude/AGENTPACK.lock — uninstall documents that it keeps them).
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-uninstall-user-${Date.now()}`);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(args: string[], home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      // os.homedir() honors $HOME on POSIX — the throwaway HOME isolates
      // every ~/.claude read/write.
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", HOME: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

/** Recursive path → sha256 snapshot of a directory tree (relative POSIX paths). */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // root may not exist yet
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) {
        const bytes = await fs.readFile(abs);
        out.set(r, createHash("sha256").update(bytes).digest("hex"));
      }
    }
  }
  await walk(root, "");
  return out;
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("uninstall --scope user (#146)", () => {
  it("user-scope install then user-scope uninstall restores the HOME tree (audit state aside)", async () => {
    const home = path.join(TMP_ROOT, "home-roundtrip");
    // Pre-existing user config the pack merges into — must survive untouched.
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude", "CLAUDE.md"),
      "# My own instructions\n\nHands off.\n",
    );
    const before = await snapshot(home);

    const inst = await run(
      [
        "install",
        EXAMPLE,
        "--target",
        "claude-code",
        "--profile",
        "safe",
        "--scope",
        "user",
        "--yes",
      ],
      home,
    );
    expect(inst.stderr).toBe("");
    expect(inst.code).toBe(0);
    // Sanity: payload landed in the user layout.
    await fs.stat(path.join(home, ".claude", "commands", "pr-summary.md"));

    const un = await run(
      ["uninstall", "agentpack.pr-quality", "--scope", "user", "--yes"],
      home,
    );
    expect(un.stderr).toBe("");
    expect(un.code).toBe(0);

    const after = await snapshot(home);
    // 1. Every pre-existing file is byte-identical.
    for (const [rel, sha] of before) {
      expect(after.get(rel), `pre-existing file changed or vanished: ${rel}`).toBe(sha);
    }
    // 2. No pack payload remains — the only additions over the pre-install
    //    tree are the retained audit artifacts.
    const auditRe = /^\.claude\/(\.agentpack\/|AGENTPACK\.lock$)/;
    for (const rel of after.keys()) {
      if (before.has(rel)) continue;
      expect(rel, `unexpected leftover outside audit state: ${rel}`).toMatch(auditRe);
    }
  });

  it("refuses --scope user combined with an explicit --project", async () => {
    const home = path.join(TMP_ROOT, "home-exclusive");
    await fs.mkdir(home, { recursive: true });
    const r = await run(
      ["uninstall", "some.pack", "--scope", "user", "--project", TMP_ROOT, "--yes"],
      home,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mutually exclusive");
  });

  it("rejects an unknown --scope value", async () => {
    const home = path.join(TMP_ROOT, "home-badscope");
    await fs.mkdir(home, { recursive: true });
    const r = await run(["uninstall", "some.pack", "--scope", "global", "--yes"], home);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid --scope");
  });
});
