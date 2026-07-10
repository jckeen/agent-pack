// Sync S1 e2e gate (#110): install from a git fixture, advance the fixture,
// and watch `agentpack update --check` report the move via exit code 10 —
// against the REAL CLI binary and a local mock GitHub server (API + raw
// hosts pointed at it via AGENTPACK_GITHUB_API_URL / AGENTPACK_GITHUB_RAW_URL).
//
// Must-NOT-happen guards baked in: `--check` performs zero filesystem writes
// (zero-trace, the #103 posture), and local-path installs keep a lockfile
// with NO `source` key (byte-stability).
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-update-cli-${Date.now()}`);

const SHA_V1 = "1111111111111111111111111111111111111111";
const SHA_V2 = "2222222222222222222222222222222222222222";

const OWNER = "fixture-owner";
const REPO = "fixture-pack";

function manifestYaml(version: string): string {
  return `agentpack: "1.0"
metadata:
  id: "fixture.sync-pack"
  name: "Sync Fixture Pack"
  slug: "sync-fixture-pack"
  description: "Test fixture for the sync S1 e2e gate — one instruction atom, no exec surface."
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
  claude-code:
    enabled: true
    output:
      instructions: "CLAUDE.md"
      skills: ".claude/skills"
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

function startMockGitHub(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // API surface (base: /api)
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
    // Raw surface (base: /raw): /raw/<owner>/<repo>/<sha>/<path>
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

function run(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...extraEnv };
    // Never send a real dev token to the mock server.
    delete env["GITHUB_TOKEN"];
    delete env["GH_TOKEN"];
    env["AGENTPACK_GITHUB_API_URL"] = `${baseUrl}/api`;
    env["AGENTPACK_GITHUB_RAW_URL"] = `${baseUrl}/raw`;
    const child = spawn("node", [CLI_ENTRY, ...args], { cwd: REPO_ROOT, env });
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

/** Recursive listing of path → mtimeMs+size, for the zero-write assertion. */
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
  await startMockGitHub();
});

// The mock fixture is shared mutable state; reset BEFORE each test (an
// end-of-test reset never runs when an assertion throws mid-test).
beforeEach(() => {
  fixture.sha = SHA_V1;
  fixture.files.set("AGENTPACK.yaml", manifestYaml("0.1.0"));
  fixture.files.set("atoms/instructions/notes.md", "# Notes v1\n");
});

afterAll(async () => {
  server?.close();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("sync S1 — provenance + update --check (e2e gate for #110)", () => {
  it("install from git records a source block in lockfile AND install manifest", async () => {
    const dir = await freshProject("git-install");
    const r = await run([
      "install",
      `github:${OWNER}/${REPO}@main`,
      "--target",
      "generic",
      "--project",
      dir,
      "--yes",
    ]);
    expect(r.code, r.stderr).toBe(0);

    const lock = JSON.parse(await fs.readFile(path.join(dir, "AGENTPACK.lock"), "utf8"));
    expect(lock.source).toEqual({
      kind: "github",
      id: `github:${OWNER}/${REPO}`,
      requestedRef: "main",
      resolvedSha: SHA_V1,
      channel: "branch",
    });

    const manifestRaw = await fs.readFile(
      path.join(dir, ".agentpack/installed/fixture.sync-pack.json"),
      "utf8",
    );
    expect(JSON.parse(manifestRaw).source).toEqual(lock.source);
  });

  it("update --check at the same SHA exits 0 and reports up to date", async () => {
    const dir = await freshProject("check-same");
    await run([
      "install",
      `github:${OWNER}/${REPO}@main`,
      "--target",
      "generic",
      "--project",
      dir,
      "--yes",
    ]);
    const r = await run(["update", "--check", "--project", dir]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  it("after the fixture advances, update --check exits 10 and prints old → new SHA", async () => {
    const dir = await freshProject("check-moved");
    await run([
      "install",
      `github:${OWNER}/${REPO}@main`,
      "--target",
      "generic",
      "--project",
      dir,
      "--yes",
    ]);

    // Advance the fixture: new commit on main with changed content.
    fixture.sha = SHA_V2;
    fixture.files.set("atoms/instructions/notes.md", "# Notes v2\n");
    fixture.files.set("AGENTPACK.yaml", manifestYaml("0.2.0"));

    const r = await run(["update", "--check", "--project", dir]);
    expect(r.code, r.stderr + r.stdout).toBe(10);
    expect(r.stdout).toContain(SHA_V1.slice(0, 12));
    expect(r.stdout).toContain(SHA_V2.slice(0, 12));

  });

  it("update --check is read-only — zero filesystem writes in the project", async () => {
    const dir = await freshProject("check-readonly");
    await run([
      "install",
      `github:${OWNER}/${REPO}@main`,
      "--target",
      "generic",
      "--project",
      dir,
      "--yes",
    ]);
    fixture.sha = SHA_V2;
    const before = await snapshotTree(dir);
    const r = await run(["update", "--check", "--project", dir]);
    expect(r.code).toBe(10);
    const after = await snapshotTree(dir);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  it("a SHA-pinned install reports pinned and exits 0 even when the branch moves", async () => {
    const dir = await freshProject("check-pinned");
    const inst = await run([
      "install",
      `github:${OWNER}/${REPO}@${SHA_V1}`,
      "--target",
      "generic",
      "--project",
      dir,
      "--yes",
    ]);
    expect(inst.code, inst.stderr).toBe(0);
    fixture.sha = SHA_V2;
    const r = await run(["update", "--check", "--project", dir]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("pinned");
  });

  it("bare `update` without --check defers to phase S2 with exit 2", async () => {
    const dir = await freshProject("bare-update");
    const r = await run(["update", "--project", dir]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--check/);
  });

  it("update --check with nothing installed exits 0", async () => {
    const dir = await freshProject("check-empty");
    const r = await run(["update", "--check", "--project", dir]);
    expect(r.code, r.stderr).toBe(0);
  });

  it("update --check --json emits machine-readable results", async () => {
    const dir = await freshProject("check-json");
    await run([
      "install",
      `github:${OWNER}/${REPO}@main`,
      "--target",
      "generic",
      "--project",
      dir,
      "--yes",
    ]);
    fixture.sha = SHA_V2;
    const r = await run(["update", "--check", "--project", dir, "--json"]);
    expect(r.code).toBe(10);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.updatesAvailable).toBe(true);
    expect(parsed.packs[0].packId).toBe("fixture.sync-pack");
    expect(parsed.packs[0].status).toBe("update-available");
    expect(parsed.packs[0].installedSha).toBe(SHA_V1);
    expect(parsed.packs[0].latestSha).toBe(SHA_V2);
  });

  it("a local-path install keeps a lockfile with NO source key", async () => {
    const dir = await freshProject("local-no-source");
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
    expect(r.code, r.stderr).toBe(0);
    const raw = await fs.readFile(path.join(dir, "AGENTPACK.lock"), "utf8");
    expect(raw).not.toContain('"source"');
    // And update --check reports it as unknown-provenance, exit 0.
    const chk = await run(["update", "--check", "--project", dir]);
    expect(chk.code, chk.stderr).toBe(0);
  });
});

describe("verify --all --quiet (sync S1)", () => {
  it("verify --all exits 0 on a clean install and --quiet silences stdout", async () => {
    const dir = await freshProject("verify-all-clean");
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
    const r = await run(["verify", "--all", "--project", dir]);
    expect(r.code, r.stderr).toBe(0);
    const q = await run(["verify", "--all", "--quiet", "--project", dir]);
    expect(q.code).toBe(0);
    expect(q.stdout.trim()).toBe("");
  });

  it("verify --all exits 2 when a tracked file drifts", async () => {
    const dir = await freshProject("verify-all-drift");
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
    const lock = JSON.parse(await fs.readFile(path.join(dir, "AGENTPACK.lock"), "utf8"));
    const tracked = lock.atoms[0].outputs[0].path as string;
    // Overwrite (not append): the first tracked output may be a marker-merged
    // file, where user content AROUND the pack's fragment is legal by design —
    // destroying the fragment is what constitutes drift.
    await fs.writeFile(path.join(dir, tracked), "corrupted\n");
    const r = await run(["verify", "--all", "--quiet", "--project", dir]);
    expect(r.code).toBe(2);
  });

  it("verify still requires a packId or --all", async () => {
    const dir = await freshProject("verify-usage");
    const r = await run(["verify", "--project", dir]);
    expect(r.code).not.toBe(0);
  });
});

describe("update --check hardening (tampered install manifest)", () => {
  // A registry-kind source block in .agentpack/installed/ is attacker-influenced
  // input (manifests travel with a cloned repo). The check path must not leak
  // ambient credentials to a manifest-supplied host, and must refuse plaintext
  // non-loopback registries outright.
  async function writeRegistryManifest(dir: string, registry: string): Promise<void> {
    await fs.mkdir(path.join(dir, ".agentpack/installed"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".agentpack/installed/evil.pack.json"),
      JSON.stringify({
        manifestVersion: 1,
        packId: "evil.pack",
        packVersion: "0.1.0",
        target: "generic",
        profile: "safe",
        installedAt: "2026-07-09T00:00:00.000Z",
        cliVersion: "0.0.0-test",
        adapterVersions: { generic: "0.0.0-test" },
        created: [],
        modified: [],
        backups: [],
        atomIds: [],
        lockfileChecksum: "0".repeat(64),
        rollbackable: true,
        source: {
          kind: "registry",
          id: "evil/pack",
          registry,
          requestedVersion: null,
          resolvedVersion: "0.1.0",
          channel: "latest",
        },
      }),
    );
  }

  it("never sends the ambient AGENTPACK_TOKEN to a manifest-supplied registry", async () => {
    const seenAuth: Array<string | undefined> = [];
    const attacker = http.createServer((req, res) => {
      seenAuth.push(req.headers["authorization"]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          publisher: "evil",
          pack: "pack",
          versions: [{ version: "9.9.9", status: "published" }],
        }),
      );
    });
    await new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", resolve));
    const addr = attacker.address();
    const attackerUrl =
      addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : "";
    try {
      const dir = await freshProject("reg-token-exfil");
      await writeRegistryManifest(dir, attackerUrl);
      const r = await run(["update", "--check", "--project", dir], {
        AGENTPACK_TOKEN: "super-secret-token",
      });
      // The check itself may report update-available (10) — the assertion that
      // matters is that no Authorization header ever reached the host.
      expect([0, 1, 10]).toContain(r.code);
      expect(seenAuth.length).toBeGreaterThan(0);
      for (const h of seenAuth) expect(h).toBeUndefined();
    } finally {
      attacker.close();
    }
  });

  it("refuses a plaintext non-loopback registry URL without contacting it", async () => {
    const dir = await freshProject("reg-plaintext");
    // TEST-NET-3 address: must never be dialed; the scheme gate rejects first.
    await writeRegistryManifest(dir, "http://203.0.113.7");
    const r = await run(["update", "--check", "--project", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/https/i);
  });
});

describe("verify in a multi-pack project (single-pack lockfile)", () => {
  // AGENTPACK.lock is single-pack and overwritten by every install; the
  // lockfile-checksum cross-check must not report a FOREIGN pack's lockfile
  // as drift for an earlier install (code-review P1 on sync S1).
  it("verify --all exits 0 when two packs are installed and untouched", async () => {
    const dir = await freshProject("verify-two-packs");
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
      `github:${OWNER}/${REPO}@main`,
      "--target",
      "claude-code",
      "--project",
      dir,
      "--yes",
    ]);
    expect(second.code, second.stderr).toBe(0);
    const r = await run(["verify", "--all", "--project", dir]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
  });
});
