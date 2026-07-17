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
    const entry = lock.packs["fixture.sync-pack"];
    expect(entry.source).toEqual({
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
    expect(JSON.parse(manifestRaw).source).toEqual(entry.source);
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

  it("bare `update` (apply path, S2) with nothing installed exits 0", async () => {
    const dir = await freshProject("bare-update");
    const r = await run(["update", "--project", dir]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("nothing to update");
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
    const tracked = lock.packs["agentpack.pr-quality"].atoms[0].outputs[0].path as string;
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

// ---------------------------------------------------------------------------
// Sync S3 (#112): `--scope user` — install/update a personal pack into
// ~/.claude on a throwaway HOME. The gate: two-throwaway-HOME round trip
// (import → install --scope user → verify clean → pack edit → update; hook
// change REFUSED without --allow-exec) and a HOME diff across --dry-run
// showing ZERO mutations.
// ---------------------------------------------------------------------------

/** Load every file under `dir` into the mock-GitHub fixture map. */
async function loadFixtureFromDir(dir: string): Promise<void> {
  fixture.files.clear();
  async function walk(sub: string): Promise<void> {
    for (const e of await fs.readdir(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(rel);
      else fixture.files.set(rel, await fs.readFile(path.join(dir, rel), "utf8"));
    }
  }
  await walk("");
}

/**
 * Seed a fixture "live" Claude Code user config under `<home>/.claude`:
 * instructions, one skill, and one hook whose script lives in
 * `~/.claude/hooks/` (so the importer bundles the script body).
 */
async function seedLiveClaudeConfig(home: string): Promise<string> {
  const claudeDir = path.join(home, ".claude");
  await fs.mkdir(path.join(claudeDir, "skills/greeting"), { recursive: true });
  await fs.mkdir(path.join(claudeDir, "hooks"), { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, "CLAUDE.md"),
    "# My Dotfiles\n\n## Notes\n\nAlways leave a note.\n",
  );
  await fs.writeFile(
    path.join(claudeDir, "skills/greeting/SKILL.md"),
    "---\nname: greeting\ndescription: Greets politely.\n---\n\n# Greeting\n\nSay hello.\n",
  );
  await fs.writeFile(
    path.join(claudeDir, "hooks/fmt.sh"),
    "#!/usr/bin/env bash\necho fmt-v1\n",
  );
  await fs.writeFile(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "bash $HOME/.claude/hooks/fmt.sh" }],
          },
        ],
      },
    }),
  );
  return claudeDir;
}

/** Import the live config at `<homeA>/.claude` into a pack dir and serve it. */
async function importAndServePack(homeA: string): Promise<string> {
  const packDir = path.join(
    TMP_ROOT,
    `user-pack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const imp = await run(
    [
      "import",
      path.join(homeA, ".claude"),
      "--from",
      "claude-code",
      "--id",
      "me.dotfiles",
      "--out",
      packDir,
    ],
    { HOME: homeA },
  );
  expect(imp.code, imp.stderr).toBe(0);
  await loadFixtureFromDir(packDir);
  return packDir;
}

describe("sync S3 — install/update --scope user (e2e gate for #112)", () => {
  it("round trip: import → install --scope user → verify clean → pack edit → update; hook change refused without --allow-exec", async () => {
    // Throwaway HOME A: the "source" machine whose live config gets imported.
    const homeA = await freshProject("home-a");
    await seedLiveClaudeConfig(homeA);
    await importAndServePack(homeA);

    // Throwaway HOME B: the "second machine". Empty — install must create ~/.claude.
    const homeB = await freshProject("home-b");
    const inst = await run(
      [
        "install",
        `github:${OWNER}/${REPO}@main`,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--yes",
        "--allow-exec",
        // Imported packs author their own target as `partial` ("still require
        // manual verification"), so the #134 acknowledgement gate applies.
        "--allow-partial-target",
      ],
      { HOME: homeB },
    );
    expect(inst.code, inst.stderr + inst.stdout).toBe(0);

    // User-scope layout: paths land under ~/.claude WITHOUT a .claude/ prefix.
    const claudeB = path.join(homeB, ".claude");
    const claudeMd = await fs.readFile(path.join(claudeB, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Always leave a note.");
    const skill = await fs.readFile(path.join(claudeB, "skills/greeting/SKILL.md"), "utf8");
    expect(skill).toContain("Say hello.");
    const settings = await fs.readFile(path.join(claudeB, "settings.json"), "utf8");
    // The hook command must reference the USER-scope script location — a
    // $CLAUDE_PROJECT_DIR path would resolve into whatever project the agent
    // happens to be in, not ~/.claude.
    expect(settings).toContain("$HOME/.claude/hooks/");
    expect(settings).not.toContain("CLAUDE_PROJECT_DIR");
    const hookScripts = await fs.readdir(path.join(claudeB, "hooks"));
    expect(hookScripts.length).toBe(1);
    // Install state lives at ~/.claude/.agentpack/, not in any project.
    const manifestRaw = await fs.readFile(
      path.join(claudeB, ".agentpack/installed/me.dotfiles.json"),
      "utf8",
    );
    expect(JSON.parse(manifestRaw).scope).toBe("user");

    // Verify clean against ~/.claude.
    const v1 = await run(["verify", "--all", "--project", claudeB], { HOME: homeB });
    expect(v1.code, v1.stderr + v1.stdout).toBe(0);

    // Pack edit #1: instruction-only change → updates under --yes alone.
    fixture.sha = SHA_V2;
    const instrPath = [...fixture.files.keys()].find((p) =>
      p.startsWith("atoms/instructions/"),
    )!;
    fixture.files.set(
      instrPath,
      fixture.files.get(instrPath)! + "\nAlso water the plants.\n",
    );
    const up1 = await run(["update", "--scope", "user", "--yes"], { HOME: homeB });
    expect(up1.code, up1.stderr + up1.stdout).toBe(0);
    expect(await fs.readFile(path.join(claudeB, "CLAUDE.md"), "utf8")).toContain(
      "Also water the plants.",
    );
    const v2 = await run(["verify", "--all", "--project", claudeB], { HOME: homeB });
    expect(v2.code, v2.stderr + v2.stdout).toBe(0);

    // Pack edit #2: hook SCRIPT change → exec-bearing delta. Refused without
    // --allow-exec even with --yes; applies with it.
    fixture.sha = "3333333333333333333333333333333333333333";
    const scriptPath = [...fixture.files.keys()].find((p) =>
      p.startsWith("atoms/hooks/scripts/"),
    )!;
    fixture.files.set(scriptPath, "#!/usr/bin/env bash\necho fmt-v2\n");
    const refused = await run(["update", "--scope", "user", "--yes"], { HOME: homeB });
    expect(refused.code, refused.stderr + refused.stdout).toBe(6);
    expect(refused.stderr).toMatch(/allow-exec/i);
    // Refusal wrote nothing: the installed script still says v1.
    const scriptName = hookScripts[0]!;
    expect(await fs.readFile(path.join(claudeB, "hooks", scriptName), "utf8")).toContain(
      "fmt-v1",
    );

    const applied = await run(["update", "--scope", "user", "--yes", "--allow-exec"], {
      HOME: homeB,
    });
    expect(applied.code, applied.stderr + applied.stdout).toBe(0);
    expect(await fs.readFile(path.join(claudeB, "hooks", scriptName), "utf8")).toContain(
      "fmt-v2",
    );
    const v3 = await run(["verify", "--all", "--project", claudeB], { HOME: homeB });
    expect(v3.code, v3.stderr + v3.stdout).toBe(0);
  }, 120_000);

  it("update --scope user --dry-run mutates NOTHING under HOME (tree diff is empty)", async () => {
    const homeA = await freshProject("home-dry-a");
    await seedLiveClaudeConfig(homeA);
    await importAndServePack(homeA);

    const homeB = await freshProject("home-dry-b");
    const inst = await run(
      [
        "install",
        `github:${OWNER}/${REPO}@main`,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--yes",
        "--allow-exec",
        // Imported packs author their own target as `partial` ("still require
        // manual verification"), so the #134 acknowledgement gate applies.
        "--allow-partial-target",
      ],
      { HOME: homeB },
    );
    expect(inst.code, inst.stderr + inst.stdout).toBe(0);

    // Advance the pack (exec-bearing change, worst case for the guard).
    fixture.sha = SHA_V2;
    const scriptPath = [...fixture.files.keys()].find((p) =>
      p.startsWith("atoms/hooks/scripts/"),
    )!;
    fixture.files.set(scriptPath, "#!/usr/bin/env bash\necho fmt-v2\n");

    const before = await snapshotTree(homeB);
    const dry = await run(
      ["update", "--scope", "user", "--dry-run", "--yes", "--allow-exec"],
      { HOME: homeB },
    );
    expect(dry.stdout).toContain("(--dry-run)");
    const after = await snapshotTree(homeB);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  }, 120_000);

  it("install --scope user --dry-run mutates NOTHING under an existing ~/.claude", async () => {
    const homeA = await freshProject("home-idry-a");
    await seedLiveClaudeConfig(homeA);
    await importAndServePack(homeA);

    const homeB = await freshProject("home-idry-b");
    // Pre-existing user config that a careless dry-run could clobber.
    await fs.mkdir(path.join(homeB, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(homeB, ".claude/settings.json"),
      JSON.stringify({ model: "opus" }),
    );
    const before = await snapshotTree(homeB);
    const dry = await run(
      [
        "install",
        `github:${OWNER}/${REPO}@main`,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--dry-run",
        "--yes",
        "--allow-exec",
      ],
      { HOME: homeB },
    );
    expect(dry.code, dry.stderr + dry.stdout).toBe(0);
    const after = await snapshotTree(homeB);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  }, 120_000);

  it("install --scope user JSON-merges into an existing ~/.claude/settings.json (user keys survive)", async () => {
    const homeA = await freshProject("home-merge-a");
    await seedLiveClaudeConfig(homeA);
    await importAndServePack(homeA);

    const homeB = await freshProject("home-merge-b");
    await fs.mkdir(path.join(homeB, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(homeB, ".claude/settings.json"),
      JSON.stringify({ model: "opus" }),
    );
    const inst = await run(
      [
        "install",
        `github:${OWNER}/${REPO}@main`,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--yes",
        "--allow-exec",
        // Imported packs author their own target as `partial` ("still require
        // manual verification"), so the #134 acknowledgement gate applies.
        "--allow-partial-target",
      ],
      { HOME: homeB },
    );
    expect(inst.code, inst.stderr + inst.stdout).toBe(0);
    const merged = JSON.parse(
      await fs.readFile(path.join(homeB, ".claude/settings.json"), "utf8"),
    );
    expect(merged.model).toBe("opus");
    expect(merged.hooks).toBeDefined();
  }, 120_000);

  it("install --scope user refuses a non-claude-code target (usage error)", async () => {
    const homeB = await freshProject("home-badtarget");
    const r = await run(
      [
        "install",
        `github:${OWNER}/${REPO}@main`,
        "--target",
        "codex",
        "--scope",
        "user",
        "--yes",
      ],
      { HOME: homeB },
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/scope user/i);
  });

  it("install --scope user --dry-run with no ~/.claude fails cleanly and creates nothing", async () => {
    const homeB = await freshProject("home-nodir");
    const r = await run(
      [
        "install",
        `github:${OWNER}/${REPO}@main`,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--dry-run",
        "--yes",
      ],
      { HOME: homeB },
    );
    expect(r.code).not.toBe(0);
    await expect(fs.stat(path.join(homeB, ".claude"))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PR #121 review round: --force interactions with the consent gates. Both
// pre-existing on master, but --scope user makes them reachable enough to fix
// here (and the fixes cover project scope too).
// ---------------------------------------------------------------------------

/** Live config whose ONLY exec surface is a bang-bash slash command. */
async function seedLiveCommandConfig(home: string): Promise<void> {
  const claudeDir = path.join(home, ".claude");
  await fs.mkdir(path.join(claudeDir, "commands"), { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, "CLAUDE.md"),
    "# Cmd Pack\n\n## Notes\n\nJust a note.\n",
  );
  await fs.writeFile(
    path.join(claudeDir, "commands/ship.md"),
    "---\ndescription: Ship it\n---\n\nRun !`git push` and report the result.\n",
  );
}

/** Live config whose settings.json declares one MCP server. */
async function seedLiveMcpConfig(home: string): Promise<void> {
  const claudeDir = path.join(home, ".claude");
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, "CLAUDE.md"),
    "# MCP Pack\n\n## Notes\n\nJust a note.\n",
  );
  await fs.writeFile(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({
      mcpServers: { shared: { command: "node", args: ["server-v1.js"] } },
    }),
  );
}

describe("--force never bypasses exec consent (#121 review HIGH)", () => {
  // The bang-bash scan is the ONLY consent gate for command/subagent atoms
  // (they are not hook/mcp_server execAtoms). --force writes conflict files
  // to disk, so conflicts MUST be in the scan — otherwise a pre-existing user
  // file at the command's path turns --force -y into silent exec consent.
  it("user scope: forced conflict on a bang-bash command file is refused without --allow-exec", async () => {
    const homeA = await freshProject("force-exec-a");
    await seedLiveCommandConfig(homeA);
    await importAndServePack(homeA);

    const homeB = await freshProject("force-exec-b");
    const userFile = path.join(homeB, ".claude/commands/ship.md");
    await fs.mkdir(path.dirname(userFile), { recursive: true });
    await fs.writeFile(userFile, "# my own ship notes\n");

    const refused = await run(
      [
        "install",
        `github:${OWNER}/${REPO}@main`,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--force",
        "--yes",
      ],
      { HOME: homeB },
    );
    expect(refused.code, refused.stderr + refused.stdout).toBe(6);
    expect(refused.stderr).toContain("commands/ship.md");
    // The refusal wrote nothing: the user's file is untouched.
    expect(await fs.readFile(userFile, "utf8")).toBe("# my own ship notes\n");

    const allowed = await run(
      [
        "install",
        `github:${OWNER}/${REPO}@main`,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--force",
        "--yes",
        "--allow-exec",
      ],
      { HOME: homeB },
    );
    expect(allowed.code, allowed.stderr + allowed.stdout).toBe(0);
    expect(await fs.readFile(userFile, "utf8")).toContain("!`git push`");
  }, 120_000);

  it("project scope: forced conflict on a bang-bash command file is refused without --allow-exec", async () => {
    const homeA = await freshProject("force-exec-proj-a");
    await seedLiveCommandConfig(homeA);
    await importAndServePack(homeA);

    const dir = await freshProject("force-exec-proj");
    const userFile = path.join(dir, ".claude/commands/ship.md");
    await fs.mkdir(path.dirname(userFile), { recursive: true });
    await fs.writeFile(userFile, "# my own ship notes\n");

    const refused = await run([
      "install",
      `github:${OWNER}/${REPO}@main`,
      "--target",
      "claude-code",
      "--project",
      dir,
      "--force",
      "--yes",
    ]);
    expect(refused.code, refused.stderr + refused.stdout).toBe(6);
    expect(refused.stderr).toContain(".claude/commands/ship.md");
    expect(await fs.readFile(userFile, "utf8")).toBe("# my own ship notes\n");

    const allowed = await run([
      "install",
      `github:${OWNER}/${REPO}@main`,
      "--target",
      "claude-code",
      "--project",
      dir,
      "--force",
      "--yes",
      "--allow-exec",
    ]);
    expect(allowed.code, allowed.stderr + allowed.stdout).toBe(0);
    expect(await fs.readFile(userFile, "utf8")).toContain("!`git push`");
  }, 120_000);
});

describe("--force on a JSON collision deep-merges, never replaces the file (#121 review MEDIUM)", () => {
  it("user's non-colliding MCP servers survive a forced .mcp.json collision", async () => {
    const homeA = await freshProject("force-json-a");
    await seedLiveMcpConfig(homeA);
    await importAndServePack(homeA);

    const homeB = await freshProject("force-json-b");
    const mcpPath = path.join(homeB, ".claude/.mcp.json");
    await fs.mkdir(path.dirname(mcpPath), { recursive: true });
    const userMcp = {
      mcpServers: {
        mine: { type: "stdio", command: "node", args: ["mine.js"], env: {} },
        shared: { type: "stdio", command: "node", args: ["different.js"], env: {} },
      },
    };
    await fs.writeFile(mcpPath, JSON.stringify(userMcp, null, 2) + "\n");

    // Without --force the collision still refuses (classification unchanged).
    const refused = await run(
      [
        "install",
        `github:${OWNER}/${REPO}@main`,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--yes",
        "--allow-exec",
      ],
      { HOME: homeB },
    );
    expect(refused.code, refused.stderr + refused.stdout).toBe(2);
    expect(JSON.parse(await fs.readFile(mcpPath, "utf8"))).toEqual(userMcp);

    // With --force: deep-merge — the pack wins ONLY the collided key; the
    // user's other servers survive (previously the bare fragment replaced
    // the whole file).
    const forced = await run(
      [
        "install",
        `github:${OWNER}/${REPO}@main`,
        "--target",
        "claude-code",
        "--scope",
        "user",
        "--yes",
        "--allow-exec",
        "--force",
      ],
      { HOME: homeB },
    );
    expect(forced.code, forced.stderr + forced.stdout).toBe(0);
    const merged = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    expect(merged.mcpServers.mine).toEqual(userMcp.mcpServers.mine);
    expect(merged.mcpServers.shared.args).toEqual(["server-v1.js"]);

    // The forced merge is recorded as a json merge, so verify stays clean.
    const v = await run(["verify", "--all", "--project", path.join(homeB, ".claude")], {
      HOME: homeB,
    });
    expect(v.code, v.stderr + v.stdout).toBe(0);
  }, 120_000);
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
