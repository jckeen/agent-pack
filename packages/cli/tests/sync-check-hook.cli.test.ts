// Sync S4 gate (#113): the first-party `agentpack.sync-check` pack ships one
// SessionStart hook that is silent when every installed pack is current and
// prints a one-line nudge when an upstream moves. The hook's contract is
// OFFLINE-SILENT: missing `agentpack` binary, dead network, or a hung server
// must produce NO output and exit 0 — a nudge that errors on every session
// start is worse than none.
//
// Harness: the real CLI binary against the S1 mock-GitHub server
// (AGENTPACK_GITHUB_API_URL / AGENTPACK_GITHUB_RAW_URL), a throwaway HOME,
// and a throwaway project. The hook script is executed directly (`sh <script>`)
// exactly as Claude Code's settings.json hook entry would run it.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SYNC_CHECK_PACK = path.resolve(REPO_ROOT, "packs/sync-check");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-sync-check-${Date.now()}`);

const SHA_V1 = "1111111111111111111111111111111111111111";
const SHA_V2 = "2222222222222222222222222222222222222222";

const OWNER = "fixture-owner";
const REPO = "fixture-pack";

const NUDGE = "AgentPack updates available — run: agentpack update";

function manifestYaml(version: string): string {
  return `agentpack: "1.0"
metadata:
  id: "fixture.sync-pack"
  name: "Sync Fixture Pack"
  slug: "sync-fixture-pack"
  description: "Test fixture for the sync S4 hook gate — one instruction atom, no exec surface."
  version: "${version}"
  license: "MIT"
  publisher: "fixture"
  authors:
    - name: "Fixture"
      email: "fixture@example.com"
  tags:
    - test
compatibility:
  targets:
    generic:
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
  - id: "instruction:notes"
    type: instruction
    name: "Notes"
    description: "A persistent instruction with no executable surface."
    path: "atoms/instructions/notes.md"
    risk_level: low
    permissions: []
exports:
  default_profile: full
  output_dir: "dist"
  lockfile: "AGENTPACK.lock"
adapters:
  generic:
    enabled: true
    output:
      instructions: "AGENTS.md"
      skills: "skills"
      manifest: "agentpack.json"
      readme: "README-agent.md"
`;
}

/** Mutable fixture state — "advancing the fixture" swaps sha + content. */
const fixture = {
  sha: SHA_V1,
  files: new Map<string, string>([
    ["AGENTPACK.yaml", manifestYaml("0.1.0")],
    ["atoms/instructions/notes.md", "# Notes v1\n"],
  ]),
};

let server: http.Server;
let baseUrl: string;
let fakeHome: string;
let binDir: string;

function startMockGitHub(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (p === `/api/repos/${OWNER}/${REPO}`) {
      return json({ default_branch: "main" });
    }
    if (p.startsWith(`/api/repos/${OWNER}/${REPO}/git/ref/tags/`)) {
      return json({ message: "Not Found" }, 404);
    }
    if (p.startsWith(`/api/repos/${OWNER}/${REPO}/commits/`)) {
      const ref = decodeURIComponent(p.split("/commits/")[1] ?? "");
      if (ref === "main" || ref === fixture.sha) return json({ sha: fixture.sha });
      if (ref === SHA_V1 || ref === SHA_V2) return json({ sha: ref });
      return json({ message: "Not Found" }, 404);
    }
    if (p.startsWith(`/api/repos/${OWNER}/${REPO}/git/trees/`)) {
      const sha = decodeURIComponent(p.split("/git/trees/")[1] ?? "").replace(/\?.*$/, "");
      if (sha !== fixture.sha) return json({ message: "Not Found" }, 404);
      return json({
        truncated: false,
        tree: [...fixture.files.keys()].map((f) => ({ path: f, type: "blob" })),
      });
    }
    const rawPrefix = `/raw/${OWNER}/${REPO}/`;
    if (p.startsWith(rawPrefix)) {
      const rest = decodeURIComponent(p.slice(rawPrefix.length));
      const slash = rest.indexOf("/");
      const sha = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      const body = sha === fixture.sha ? fixture.files.get(file) : undefined;
      if (body === undefined) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(body);
    }
    return json({ message: `unhandled ${p}` }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run the real CLI (installs / setup steps), pointed at the mock GitHub. */
function runCli(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
    delete env["GITHUB_TOKEN"];
    delete env["GH_TOKEN"];
    env["AGENTPACK_GITHUB_API_URL"] = `${baseUrl}/api`;
    env["AGENTPACK_GITHUB_RAW_URL"] = `${baseUrl}/raw`;
    env["HOME"] = fakeHome;
    const child = spawn("node", [CLI_ENTRY, ...args], { cwd: REPO_ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

/**
 * Run the installed hook script the way Claude Code would: `sh <script>` with
 * CLAUDE_PROJECT_DIR set, a throwaway HOME, and a PATH shim for `agentpack`.
 * The environment is built from scratch (not inherited) so the test can never
 * leak the developer's real HOME, tokens, or agentpack installation into the
 * hook run.
 */
function runHook(
  project: string,
  envOverrides: Record<string, string> = {},
  { omitShim = false } = {},
): Promise<RunResult> {
  const nodeBinDir = path.dirname(process.execPath);
  const pathEntries = omitShim
    ? [nodeBinDir, "/usr/bin", "/bin"]
    : [binDir, nodeBinDir, "/usr/bin", "/bin"];
  const env: Record<string, string> = {
    PATH: pathEntries.join(path.delimiter),
    HOME: fakeHome,
    CLAUDE_PROJECT_DIR: project,
    AGENTPACK_GITHUB_API_URL: `${baseUrl}/api`,
    AGENTPACK_GITHUB_RAW_URL: `${baseUrl}/raw`,
    ...envOverrides,
  };
  return new Promise((resolve) => {
    const child = spawn("sh", [path.join(project, ".claude/hooks/sync-check.sh")], {
      cwd: project,
      env,
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

/** Install sync-check (exec consent) + the git fixture pack into `dir`. */
async function setUpProject(name: string): Promise<string> {
  const dir = await freshProject(name);
  const syncCheck = await runCli([
    "install",
    SYNC_CHECK_PACK,
    "--target",
    "claude-code",
    "--project",
    dir,
    "--yes",
    "--allow-exec",
  ]);
  expect(syncCheck.code, syncCheck.stderr || syncCheck.stdout).toBe(0);
  const fixtureInstall = await runCli([
    "install",
    `github:${OWNER}/${REPO}@main`,
    "--target",
    "generic",
    "--project",
    dir,
    "--yes",
  ]);
  expect(fixtureInstall.code, fixtureInstall.stderr || fixtureInstall.stdout).toBe(0);
  return dir;
}

/** Recursive path → mtimeMs+size listing, for the read-only assertion. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const st = await fs.stat(abs);
      out.set(path.relative(root, abs), `${st.mtimeMs}:${st.size}`);
      if (e.isDirectory()) await walk(abs);
    }
  }
  await walk(root);
  return out;
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  fakeHome = path.join(TMP_ROOT, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  // PATH shim so the hook's bare `agentpack` resolves to the built CLI.
  binDir = path.join(TMP_ROOT, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const shim = path.join(binDir, "agentpack");
  await fs.writeFile(shim, `#!/bin/sh\nexec node "${CLI_ENTRY}" "$@"\n`);
  await fs.chmod(shim, 0o755);
  await startMockGitHub();
});

beforeEach(() => {
  fixture.sha = SHA_V1;
  fixture.files.set("AGENTPACK.yaml", manifestYaml("0.1.0"));
  fixture.files.set("atoms/instructions/notes.md", "# Notes v1\n");
});

afterAll(async () => {
  server?.close();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("sync S4 — agentpack.sync-check pack shape", () => {
  it("validates and installs a SessionStart hook + bundled script", async () => {
    const validate = await runCli(["validate", SYNC_CHECK_PACK]);
    expect(validate.code, validate.stderr || validate.stdout).toBe(0);

    const dir = await freshProject("shape");
    const r = await runCli([
      "install",
      SYNC_CHECK_PACK,
      "--target",
      "claude-code",
      "--project",
      dir,
      "--yes",
      "--allow-exec",
    ]);
    expect(r.code, r.stderr || r.stdout).toBe(0);

    const script = await fs.readFile(path.join(dir, ".claude/hooks/sync-check.sh"), "utf8");
    expect(script).toContain("update --check --quiet");

    const settings = JSON.parse(
      await fs.readFile(path.join(dir, ".claude/settings.json"), "utf8"),
    ) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const sessionStart = settings.hooks?.["SessionStart"];
    expect(sessionStart, "expected a SessionStart hook").toBeDefined();
    expect(sessionStart![0]!.hooks[0]!.command).toBe(
      "sh ${CLAUDE_PROJECT_DIR}/.claude/hooks/sync-check.sh",
    );
  });

  it("refuses to install without --allow-exec (unsigned exec-bearing pack)", async () => {
    const dir = await freshProject("consent");
    const r = await runCli([
      "install",
      SYNC_CHECK_PACK,
      "--target",
      "claude-code",
      "--project",
      dir,
      "--yes",
    ]);
    expect(r.code).not.toBe(0);
  });
});

describe("sync S4 — hook gate: silent when current, nudges when the fixture moves", () => {
  it("is silent (exit 0, zero output, zero writes) when everything is current", async () => {
    const dir = await setUpProject("current");
    const before = await snapshotTree(dir);

    const r = await runHook(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");

    // Read-only nudge: the hook run must not touch the project tree.
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it("prints the one-line nudge (still exit 0) when the upstream moves", async () => {
    const dir = await setUpProject("moved");

    // Advance the fixture: new SHA, new content.
    fixture.sha = SHA_V2;
    fixture.files.set("AGENTPACK.yaml", manifestYaml("0.2.0"));
    fixture.files.set("atoms/instructions/notes.md", "# Notes v2\n");

    const r = await runHook(dir);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(NUDGE);
    expect(r.stderr).toBe("");
  });
});

describe("sync S4 — OFFLINE-SILENT contract", () => {
  it("network down (connection refused): no output, exit 0", async () => {
    const dir = await setUpProject("offline");
    const r = await runHook(dir, {
      // TEST-NET style dead endpoint: nothing listens on this port.
      AGENTPACK_GITHUB_API_URL: "http://127.0.0.1:9/api",
      AGENTPACK_GITHUB_RAW_URL: "http://127.0.0.1:9/raw",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("agentpack binary missing from PATH: no output, exit 0", async () => {
    const dir = await setUpProject("no-binary");
    const r = await runHook(dir, {}, { omitShim: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("hung server: bounded timeout kills the check — no output, exit 0", async () => {
    const dir = await setUpProject("hung");
    // A server that accepts connections and never responds.
    const hang = net.createServer(() => {
      /* accept and stall */
    });
    await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
    const addr = hang.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    try {
      const r = await runHook(dir, {
        AGENTPACK_GITHUB_API_URL: `http://127.0.0.1:${port}/api`,
        AGENTPACK_GITHUB_RAW_URL: `http://127.0.0.1:${port}/raw`,
        AGENTPACK_SYNC_CHECK_TIMEOUT: "1",
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    } finally {
      hang.close();
    }
  });

  it("no packs installed at all: no output, exit 0", async () => {
    const dir = await freshProject("empty");
    // Copy just the hook script in (simulates a hand-copied nudge script).
    await fs.mkdir(path.join(dir, ".claude/hooks"), { recursive: true });
    await fs.copyFile(
      path.join(SYNC_CHECK_PACK, "atoms/hooks/scripts/sync-check.sh"),
      path.join(dir, ".claude/hooks/sync-check.sh"),
    );
    const r = await runHook(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });
});
