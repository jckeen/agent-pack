/**
 * Issue #35 fix 2 — `verify --sig` footgun.
 *
 * `--sig` historically exited 0 on an UNSIGNED lockfile unless `--strict` was
 * also passed — a CI footgun (a flag named `--sig` silently passing when no
 * signature exists). `--sig` now ENFORCES by default: an unsigned lockfile
 * fails (exit 5). The lenient "verify the signature only if one is present"
 * behavior moves behind an explicit `--sig-if-present`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");
const TMP_ROOT = path.join(os.tmpdir(), `agentpack-verify-sig-cli-${Date.now()}`);

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

async function installUnsigned(name: string): Promise<string> {
  const dir = path.join(TMP_ROOT, name);
  await fs.mkdir(dir, { recursive: true });
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
  return dir;
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("verify --sig enforcement (#35 fix 2)", () => {
  it("--sig FAILS on an unsigned lockfile by default (exit 5)", async () => {
    const dir = await installUnsigned("sig-default");
    const r = await run(["verify", "agentpack.pr-quality", "--project", dir, "--sig"]);
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/unsigned/i);
  });

  it("--sig-if-present is lenient on an unsigned lockfile (exit 0)", async () => {
    const dir = await installUnsigned("sig-if-present");
    const r = await run([
      "verify",
      "agentpack.pr-quality",
      "--project",
      dir,
      "--sig-if-present",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/clean/i);
    expect(r.stdout).toMatch(/unsigned/i);
  });

  it("help documents both flags", async () => {
    const r = await run(["verify", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--sig");
    expect(r.stdout).toContain("--sig-if-present");
  });
});
