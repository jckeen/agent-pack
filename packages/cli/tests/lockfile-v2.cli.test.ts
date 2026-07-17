// Lockfile v2 (#114): multi-pack AGENTPACK.lock through the real CLI binary —
// install two packs, both entries persist; verify --all stays clean; uninstall
// removes only its own entry and deletes the file with the last pack.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");
const EXAMPLE_ID = "agentpack.pr-quality";
const FIXTURE_ID = "fixture.lockv2-pack";

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-lockv2-cli-${Date.now()}`);
let FIXTURE_PACK: string;

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

async function installBoth(dir: string): Promise<void> {
  const first = await run([
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
  expect(first.code, first.stderr).toBe(0);
  const second = await run([
    "install",
    FIXTURE_PACK,
    "--target",
    "claude-code",
    "--project",
    dir,
    "--yes",
  ]);
  expect(second.code, second.stderr).toBe(0);
}

async function readLock(
  dir: string,
): Promise<{ lockfileVersion: number; packs: Record<string, { packId: string }> } | null> {
  const raw = await fs.readFile(path.join(dir, "AGENTPACK.lock"), "utf8").catch(() => null);
  return raw === null ? null : JSON.parse(raw);
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  // A second local pack, claude-code target, marker-merging into CLAUDE.md —
  // coexists with pr-quality in one project.
  FIXTURE_PACK = path.join(TMP_ROOT, "fixture-pack");
  await fs.mkdir(path.join(FIXTURE_PACK, "atoms/instructions"), { recursive: true });
  await fs.writeFile(
    path.join(FIXTURE_PACK, "AGENTPACK.yaml"),
    `agentpack: "1.0"
metadata:
  id: "${FIXTURE_ID}"
  name: "Lockfile v2 Fixture"
  slug: "lockv2-pack"
  description: "Second pack for the multi-pack lockfile CLI tests."
  version: "0.1.0"
  license: "MIT"
  publisher: "fixture"
  authors:
    - name: "Fixture"
      email: "fixture@example.com"
  tags:
    - test
compatibility:
  targets:
    claude-code:
      status: supported
permissions:
  filesystem:
    read:
      - "."
  package_installation: false
  model_provider_key_access: false
security:
  risk_level: low
  risk_summary: "Low — instruction content only."
  requires_review: false
  signed: false
profiles:
  full:
    description: "Everything."
    include:
      - "*"
atoms:
  - id: "instruction:lockv2-notes"
    type: instruction
    name: "Lockv2 Notes"
    description: "A persistent instruction with no executable surface."
    path: "atoms/instructions/notes.md"
    risk_level: low
    permissions: []
exports:
  default_profile: full
  output_dir: "dist"
  lockfile: "AGENTPACK.lock"
adapters:
  claude-code:
    enabled: true
    output:
      instructions: "CLAUDE.md"
      skills: ".claude/skills"
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(FIXTURE_PACK, "atoms/instructions/notes.md"),
    "# Lockv2 notes\n",
    "utf8",
  );
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("multi-pack AGENTPACK.lock (CLI)", () => {
  it("two installs produce a v2 lockfile holding both packs, verify --all clean", async () => {
    const dir = await freshProject("two-packs");
    await installBoth(dir);
    const lock = await readLock(dir);
    expect(lock?.lockfileVersion).toBe(2);
    expect(Object.keys(lock?.packs ?? {}).sort()).toEqual([EXAMPLE_ID, FIXTURE_ID]);
    const v = await run(["verify", "--all", "--project", dir]);
    expect(v.code, v.stderr + v.stdout).toBe(0);
  });

  it("uninstall removes only its own entry, then the file with the last pack", async () => {
    const dir = await freshProject("uninstall-entries");
    await installBoth(dir);

    const first = await run(["uninstall", FIXTURE_ID, "--project", dir, "--yes"]);
    expect(first.code, first.stderr).toBe(0);
    const afterFirst = await readLock(dir);
    expect(Object.keys(afterFirst?.packs ?? {})).toEqual([EXAMPLE_ID]);
    // The surviving pack still verifies clean against its retained entry.
    const v = await run(["verify", EXAMPLE_ID, "--project", dir]);
    expect(v.code, v.stderr + v.stdout).toBe(0);

    const second = await run(["uninstall", EXAMPLE_ID, "--project", dir, "--yes"]);
    expect(second.code, second.stderr).toBe(0);
    expect(await readLock(dir)).toBeNull();
  });

  it("verify --sig reports unsigned per pack entry (exit 5), not the last-installed pack", async () => {
    const dir = await freshProject("sig-per-entry");
    await installBoth(dir);
    // Both are unsigned local installs; the point is the lookup succeeds for
    // the FIRST-installed pack too (pre-v2 the lockfile only held the last).
    const r = await run(["verify", EXAMPLE_ID, "--sig", "--project", dir]);
    expect(r.code, r.stderr + r.stdout).toBe(5);
  });

  it("verify --sig fails loudly when the lockfile has no entry for the pack", async () => {
    const dir = await freshProject("sig-missing-entry");
    await installBoth(dir);
    // Drop the example pack's entry, keeping a valid v2 document.
    const lockPath = path.join(dir, "AGENTPACK.lock");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    delete lock.packs[EXAMPLE_ID];
    await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
    const r = await run(["verify", EXAMPLE_ID, "--sig", "--project", dir]);
    expect(r.code, r.stderr + r.stdout).toBe(4);
  });
});
