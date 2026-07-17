import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPack, TARGET_PLATFORMS, type TargetPlatform } from "@agentpack/core";

// #119 regression suite: the exec-consent content scan derives its surface
// from the adapters' `execCapable` declarations, not from a hardcoded path
// regex in install.ts. The expected gating per target is COMPUTED from the
// adapter output here, so a target that later gains (or loses) an
// exec-capable command surface flips these assertions instead of silently
// bypassing the gate.

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const FIXTURES = path.resolve(__dirname, "fixtures");
const EXEC_COMMAND = path.join(FIXTURES, "exec-command");
const EXEC_HOOK = path.join(FIXTURES, "exec-hook");
const EXEC_MCP = path.join(FIXTURES, "exec-mcp");

const BANG_BASH = /!`/;

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-exec-surfaces-cli-${Date.now()}`);

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
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...options.env },
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

/** Adapter-declared truth: does this target mark any planned output of the
 * bang-bash command fixture as an exec-capable file carrying a directive? */
async function adapterDeclaresExecSurface(target: TargetPlatform): Promise<boolean> {
  const outDir = path.join(TMP_ROOT, `export-${target}`);
  const result = await exportPack({
    source: EXEC_COMMAND,
    target,
    profile: "full",
    outDir,
  });
  return result.plan.files.some((f) => f.execCapable === true && BANG_BASH.test(f.content));
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("exec-consent scan surfaces derive from adapters (#119)", () => {
  it("at least claude-code declares an exec-capable command surface (anti-vacuity)", async () => {
    expect(await adapterDeclaresExecSurface("claude-code")).toBe(true);
  });

  it.each(TARGET_PLATFORMS)(
    "%s: a bang-bash command atom is gated iff the adapter marks a command surface exec-capable",
    async (target) => {
      const expectGate = await adapterDeclaresExecSurface(target);
      const dir = await freshProject(`bang-bash-${target}`);
      const r = await run([
        "install",
        EXEC_COMMAND,
        "--target",
        target,
        "--profile",
        "full",
        "--project",
        dir,
        "--yes",
        "--json",
      ]);
      if (expectGate) {
        expect(r.code).toBe(6); // ExitCode.PolicyViolation
        const parsed = JSON.parse(r.stdout.trim());
        expect(parsed.installed).toBe(false);
        expect(parsed.error).toBe("exec_atoms_refused");
        expect(parsed.execFiles?.length).toBeGreaterThan(0);
      } else {
        // No exec-capable surface declared → the content-level gate must NOT
        // fire, even though the body text still contains the directive.
        expect(r.code).toBe(0);
        const parsed = JSON.parse(r.stdout.trim());
        expect(parsed.installed).toBe(true);
      }
    },
  );

  it("user scope (~/.claude layout, sync S3) stays covered: a bang-bash atom installed with --scope user is gated", async () => {
    const fakeHome = await freshProject("user-scope-home");
    await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
    const r = await run(
      [
        "install",
        EXEC_COMMAND,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--profile",
        "full",
        "--yes",
        "--json",
      ],
      { env: { HOME: fakeHome } },
    );
    expect(r.code).toBe(6);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.error).toBe("exec_atoms_refused");
    // User layout drops the `.claude/` prefix — the flag rides the remapped file.
    expect(parsed.execFiles).toEqual(expect.arrayContaining(["commands/deploy.md"]));
    // Refused before apply: nothing written into the fake home.
    const cmd = await fs
      .stat(path.join(fakeHome, ".claude/commands/deploy.md"))
      .catch(() => null);
    expect(cmd).toBeNull();
  });

  it("user scope proceeds with --allow-exec and lands the file at the user layout path", async () => {
    const fakeHome = await freshProject("user-scope-home-allow");
    await fs.mkdir(path.join(fakeHome, ".claude"), { recursive: true });
    const r = await run(
      [
        "install",
        EXEC_COMMAND,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--profile",
        "full",
        "--yes",
        "--allow-exec",
      ],
      { env: { HOME: fakeHome } },
    );
    expect(r.code).toBe(0);
    const cmd = await fs
      .stat(path.join(fakeHome, ".claude/commands/deploy.md"))
      .catch(() => null);
    expect(cmd).not.toBeNull();
  });

  // Atom-level gating (hook / mcp_server) is independent of the content scan:
  // it keys off plan.atomTypes and must keep firing on EVERY target, including
  // ones with no exec-capable command surface.
  it.each(TARGET_PLATFORMS)(
    "%s: a hook atom stays gated at the atom level",
    async (target) => {
      const dir = await freshProject(`hook-${target}`);
      const r = await run([
        "install",
        EXEC_HOOK,
        "--target",
        target,
        "--profile",
        "full",
        "--project",
        dir,
        "--yes",
        "--json",
      ]);
      expect(r.code).toBe(6);
      const parsed = JSON.parse(r.stdout.trim());
      expect(parsed.error).toBe("exec_atoms_refused");
      expect(parsed.execAtoms).toEqual(expect.arrayContaining(["hook:post-edit-format"]));
    },
  );

  it.each(TARGET_PLATFORMS)(
    "%s: an mcp_server atom stays gated at the atom level",
    async (target) => {
      const dir = await freshProject(`mcp-${target}`);
      const r = await run([
        "install",
        EXEC_MCP,
        "--target",
        target,
        "--profile",
        "full",
        "--project",
        dir,
        "--yes",
        "--json",
      ]);
      expect(r.code).toBe(6);
      const parsed = JSON.parse(r.stdout.trim());
      expect(parsed.error).toBe("exec_atoms_refused");
      expect(parsed.execAtoms).toEqual(expect.arrayContaining(["mcp_server:demo"]));
    },
  );
});
