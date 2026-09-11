// #194: `uninstall --scope user` over several user roots must discover every
// root's conflicts / unparsable configs BEFORE any mutation. Previously each
// root was planned and applied in turn, so a conflict in the second root left
// the first root already uninstalled with no way back.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");
const PACK_ID = "agentpack.pr-quality";

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-uninstall-multiroot-${Date.now()}`);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(args: string[], home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
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
      return;
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

/** Install the example pack (safe profile) into BOTH ~/.claude and ~/.codex. */
async function installIntoBothRoots(home: string): Promise<void> {
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  for (const target of ["claude-code", "codex"]) {
    const r = await run(
      [
        "install",
        EXAMPLE,
        "--target",
        target,
        "--profile",
        "safe",
        "--scope",
        "user",
        "--yes",
      ],
      home,
    );
    expect(r.code, `${target}: ${r.stderr}${r.stdout}`).toBe(0);
  }
  await fs.stat(path.join(home, ".claude", "commands", "pr-summary.md"));
  await fs.stat(path.join(home, ".codex", "skills", "code-review", "SKILL.md"));
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("uninstall --scope user across several roots (#194)", () => {
  it("a conflict in the SECOND root refuses the whole uninstall with every root unchanged", async () => {
    const home = path.join(TMP_ROOT, "home-conflict");
    await installIntoBothRoots(home);
    // User edits a pack-created file in ~/.codex — the root scanned AFTER
    // ~/.claude. Without a cross-root pre-scan ~/.claude is uninstalled
    // before this conflict is discovered.
    const edited = path.join(home, ".codex", "skills", "code-review", "SKILL.md");
    await fs.appendFile(edited, "\nMy local tweak.\n");
    const before = await snapshot(home);

    const refused = await run(["uninstall", PACK_ID, "--scope", "user", "--yes"], home);
    expect(refused.code, refused.stderr + refused.stdout).toBe(2);
    expect(refused.stderr).toMatch(/conflict/i);
    expect(refused.stderr).toContain("skills/code-review/SKILL.md");

    const after = await snapshot(home);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());

    // The plan for BOTH roots is shown before the refusal, and --force then
    // completes both roots (existing force semantics unchanged).
    const forced = await run(
      ["uninstall", PACK_ID, "--scope", "user", "--yes", "--force"],
      home,
    );
    expect(forced.code, forced.stderr + forced.stdout).toBe(0);
    expect(forced.stdout).toContain(path.join(home, ".claude"));
    expect(forced.stdout).toContain(path.join(home, ".codex"));
    await expect(
      fs.stat(path.join(home, ".claude", "commands", "pr-summary.md")),
    ).rejects.toThrow();
    await expect(fs.stat(edited)).rejects.toThrow();
  }, 120_000);

  it("an unparsable merged config in the SECOND root refuses before touching the first", async () => {
    const home = path.join(TMP_ROOT, "home-unparsable");
    await installIntoBothRoots(home);
    const config = path.join(home, ".codex", "config.toml");
    await fs.appendFile(config, "\n[[broken\n");
    const before = await snapshot(home);

    const refused = await run(["uninstall", PACK_ID, "--scope", "user", "--yes"], home);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/not valid TOML/i);
    // --force does not bypass an unparsable config either.
    const forced = await run(
      ["uninstall", PACK_ID, "--scope", "user", "--yes", "--force"],
      home,
    );
    expect(forced.code).not.toBe(0);

    const after = await snapshot(home);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  }, 120_000);

  it("--force-restore alone still refuses a created-file conflict in any root", async () => {
    const home = path.join(TMP_ROOT, "home-force-restore");
    await installIntoBothRoots(home);
    await fs.appendFile(
      path.join(home, ".codex", "skills", "code-review", "SKILL.md"),
      "\nMy local tweak.\n",
    );
    const before = await snapshot(home);
    const r = await run(
      ["uninstall", PACK_ID, "--scope", "user", "--yes", "--force-restore"],
      home,
    );
    expect(r.code, r.stderr + r.stdout).toBe(2);
    const after = await snapshot(home);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  }, 120_000);
});
