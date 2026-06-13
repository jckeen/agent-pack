import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-install-cli-${Date.now()}`);

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

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("agentpack install (CLI)", () => {
  it("--help mentions every Phase 2 command", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("install");
    expect(r.stdout).toContain("uninstall");
    expect(r.stdout).toContain("diff");
    expect(r.stdout).toContain("history");
    expect(r.stdout).toContain("rollback");
    expect(r.stdout).toContain("verify");
  });

  it("dry-run exits 0 and writes nothing", async () => {
    const dir = await freshProject("dry-run");
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
    expect(r.stdout).toContain("dry-run");
    expect(r.stdout).toContain("Permissions:");
    expect(r.stdout).toContain("Read files in the project");
    const lockExists = await fs.stat(path.join(dir, "AGENTPACK.lock")).catch(() => null);
    expect(lockExists).toBeNull();
  });

  it("plan summary shows the full permission surface before consent", async () => {
    const dir = await freshProject("consent-permissions");
    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "claude-code",
      "--profile",
      "full",
      "--project",
      dir,
      "--dry-run",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Permissions:");
    expect(r.stdout).toContain("HIGH RISK");
    expect(r.stdout).toContain("Run shell commands on your machine");
    expect(r.stdout).toContain("Required secrets:");
    expect(r.stdout).toContain("GITHUB_TOKEN");
    expect(r.stdout).toContain("Network domains:");
    expect(r.stdout).toContain("api.github.com");
    expect(r.stdout).toContain("Declared shell commands:");
    expect(r.stdout).toContain("npm run format");
  });

  it("critical-risk refusal emits structured JSON with --json (codex P2)", async () => {
    const dir = await freshProject("critical-json");
    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "claude-code",
      "--profile",
      "full",
      "--project",
      dir,
      "--yes",
      "--json",
    ]);
    expect(r.code).toBe(6);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.installed).toBe(false);
    expect(parsed.error).toBe("critical_risk_refused");
    expect(parsed.riskLevel).toBe("critical");
    // Nothing was written.
    const lock = await fs.stat(path.join(dir, "AGENTPACK.lock")).catch(() => null);
    expect(lock).toBeNull();
  });

  it("--fail-on-unsupported aborts when a selected atom is dropped (codex P1)", async () => {
    const dir = await freshProject("fail-unsupported");
    // cursor/full drops `hook:post-edit-format` (target-incompatible). With the
    // strict flag the install must refuse rather than silently exit 0.
    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "cursor",
      "--profile",
      "full",
      "--project",
      dir,
      "--yes",
      "--allow-critical",
      "--fail-on-unsupported",
      "--json",
    ]);
    expect(r.code).toBe(2);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.installed).toBe(false);
    expect(parsed.error).toBe("unsupported_atoms");
    expect(parsed.unsupportedAtoms).toContain("hook:post-edit-format");
    const lock = await fs.stat(path.join(dir, "AGENTPACK.lock")).catch(() => null);
    expect(lock).toBeNull();
  });

  it("default install surfaces dropped atoms but still succeeds", async () => {
    const dir = await freshProject("drop-warn");
    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "cursor",
      "--profile",
      "full",
      "--project",
      dir,
      "--yes",
      "--allow-critical",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Installed");
    expect(r.stdout).toMatch(/NOT installed/);
    expect(r.stdout).toContain("hook:post-edit-format");
  });

  it("install + verify + uninstall happy path", async () => {
    const dir = await freshProject("happy-path");
    const install = await run([
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
    expect(install.code).toBe(0);
    expect(install.stdout).toContain("Installed");

    const lockBytes = await fs.readFile(path.join(dir, "AGENTPACK.lock"), "utf8");
    expect(lockBytes).toContain('"lockfileVersion": 1');

    const verify = await run(["verify", "agentpack.pr-quality", "--project", dir]);
    expect(verify.code).toBe(0);
    expect(verify.stdout).toContain("clean");

    const history = await run(["history", "--project", dir, "--limit", "10"]);
    expect(history.code).toBe(0);
    expect(history.stdout).toContain("install_commit");

    const uninstall = await run([
      "uninstall",
      "agentpack.pr-quality",
      "--project",
      dir,
      "--yes",
    ]);
    expect(uninstall.code).toBe(0);
    expect(uninstall.stdout).toContain("Uninstalled");

    const post = await run(["verify", "agentpack.pr-quality", "--project", dir]);
    // ISC-295: a missing install manifest is a NotFound condition → exit 8,
    // not the generic 1 that failCleanly used to hardcode.
    expect(post.code).toBe(8);
    expect(post.stderr).toMatch(/No install manifest/);
  });

  it("rollback of an idempotent reinstall keeps the pack installed (QA P1)", async () => {
    const dir = await freshProject("reinstall-rollback");
    const args = [
      "install",
      EXAMPLE,
      "--target",
      "generic",
      "--profile",
      "safe",
      "--project",
      dir,
      "--yes",
    ];
    expect((await run(args)).code).toBe(0);
    expect((await run(args)).code).toBe(0); // idempotent reinstall

    const rb = await run(["rollback", "--project", dir, "--yes"]);
    expect(rb.code).toBe(0);
    expect(rb.stdout).toMatch(/Still installed/i);

    // The pack is still there and verifies clean — the reinstall undo did not
    // remove it.
    const verify = await run(["verify", "agentpack.pr-quality", "--project", dir]);
    expect(verify.code).toBe(0);
    expect(verify.stdout).toContain("clean");
  });

  it("verify detects drift after manual edit", async () => {
    const dir = await freshProject("drift");
    await run([
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
    // Tamper INSIDE the pack's marker span — edits outside it are the user's
    // own content and are deliberately not drift under merge semantics.
    const cur = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    await fs.writeFile(
      path.join(dir, "AGENTS.md"),
      cur.replace("Pull Request Quality Pack", "Tampered Pack"),
      "utf8",
    );
    const r = await run(["verify", "agentpack.pr-quality", "--project", dir]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("drift");
    expect(r.stderr).toContain("AGENTS.md");
  });

  it("rollback undoes the most recent install", async () => {
    const dir = await freshProject("rollback");
    await run([
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
    const r = await run(["rollback", "--project", dir, "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Rolled back");
    const lockExists = await fs
      .stat(path.join(dir, ".agentpack/installed/agentpack.pr-quality.json"))
      .catch(() => null);
    expect(lockExists).toBeNull();
  });

  it("history --json emits one JSON line per entry", async () => {
    const dir = await freshProject("history-json");
    await run([
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
    const r = await run(["history", "--project", dir, "--json"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2); // begin + commit
    for (const l of lines) {
      const parsed = JSON.parse(l) as { entryChecksum: string; action: string };
      expect(parsed.entryChecksum).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.action).toMatch(/^install_(begin|commit)$/);
    }
  });

  it("diff prints unified diff for a conflict", async () => {
    const dir = await freshProject("diff");
    await fs.mkdir(path.join(dir, "skills/code-review"), { recursive: true });
    await fs.writeFile(path.join(dir, "skills/code-review/SKILL.md"), "user content\n");
    const r = await run([
      "diff",
      EXAMPLE,
      "--target",
      "generic",
      "--profile",
      "safe",
      "--project",
      dir,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("conflict");
    expect(r.stdout).toContain("skills/code-review/SKILL.md");
  });

  it("install refuses conflicts without --force", async () => {
    const dir = await freshProject("conflict-refuse");
    await fs.mkdir(path.join(dir, "skills/code-review"), { recursive: true });
    await fs.writeFile(path.join(dir, "skills/code-review/SKILL.md"), "user content\n");
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
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("conflict");
  });

  it("--target validation rejects unknown target", async () => {
    const dir = await freshProject("bad-target");
    const r = await run([
      "install",
      EXAMPLE,
      "--target",
      "vscode-extension",
      "--profile",
      "safe",
      "--project",
      dir,
      "--yes",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Invalid --target");
  });
});
