// #132: Codex user scope — the two-throwaway-HOME round trip, mirroring the
// claude-code S3 e2e gate (update.cli.test.ts): import a live ~/.codex from
// HOME A, serve it via the mock GitHub harness, install/verify/update/
// uninstall it under HOME B with `--scope user --target codex`.
//
// Pinned invariants:
//   • user-layout mapping: AGENTS.md, config.toml, hooks.json, skills/,
//     agents/*.toml — all under ~/.codex, state at ~/.codex/.agentpack/
//   • config.toml deep-merges: trust settings + unrelated machine entries
//     survive install, update, and uninstall (criterion 4)
//   • --force never implies --allow-exec (criterion 5)
//   • --dry-run leaves HOME byte-identical (sha256 tree snapshot)
//   • an exec-bearing update (hook command change) refuses without a fresh
//     --allow-exec, even with --yes
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const TMP_ROOT = path.join(os.tmpdir(), `agentpack-user-codex-${Date.now()}`);

const SHA_V1 = "1111111111111111111111111111111111111111";
const SHA_V2 = "2222222222222222222222222222222222222222";
const SHA_V3 = "3333333333333333333333333333333333333333";
const OWNER = "fixture-owner";
const REPO = "fixture-codex-pack";
const PACK_ID = "me.codexfiles";

/** Mutable fixture state — "advancing the fixture" swaps sha + content. */
const fixture = { sha: SHA_V1, files: new Map<string, string>() };

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
    if (p === `/api/repos/${OWNER}/${REPO}`) return json({ default_branch: "main" });
    if (p.startsWith(`/api/repos/${OWNER}/${REPO}/git/ref/tags/`)) {
      return json({ message: "Not Found" }, 404);
    }
    if (p.startsWith(`/api/repos/${OWNER}/${REPO}/commits/`)) {
      const ref = decodeURIComponent(p.split("/commits/")[1] ?? "");
      if (ref === "main" || ref === fixture.sha) return json({ sha: fixture.sha });
      if ([SHA_V1, SHA_V2, SHA_V3].includes(ref)) return json({ sha: ref });
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
      if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
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

async function freshHome(name: string): Promise<string> {
  const dir = path.join(TMP_ROOT, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Recursive path → sha256(content) snapshot: dry-runs must be byte-identical. */
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
      if (e.isDirectory()) {
        out.set(`${path.relative(root, abs)}/`, "<dir>");
        await walk(abs);
      } else if (e.isFile()) {
        const hash = createHash("sha256")
          .update(await fs.readFile(abs))
          .digest("hex");
        out.set(path.relative(root, abs), hash);
      }
    }
  }
  await walk(root);
  return out;
}

/** Seed a fixture "live" Codex user config under `<home>/.codex`. */
async function seedLiveCodexConfig(home: string): Promise<void> {
  const codexDir = path.join(home, ".codex");
  await fs.mkdir(path.join(codexDir, "skills/greeting"), { recursive: true });
  await fs.writeFile(
    path.join(codexDir, "AGENTS.md"),
    "# My Codex Setup\n\n## Notes\n\nAlways leave a note.\n",
  );
  await fs.writeFile(
    path.join(codexDir, "hooks.json"),
    JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: "echo fmt-v1" }] },
        ],
      },
    }),
  );
  await fs.writeFile(
    path.join(codexDir, "config.toml"),
    `[mcp_servers.local-notes]\ncommand = "notes-mcp"\nargs = ["--stdio"]\n`,
  );
  await fs.writeFile(
    path.join(codexDir, "skills/greeting/SKILL.md"),
    "---\nname: greeting\ndescription: Greets politely.\n---\n\n# Greeting\n\nSay hello.\n",
  );
}

/** Machine-local Codex config on the TARGET machine — must survive installs. */
const LIVE_TARGET_CONFIG = `model = "gpt-5.3-codex"
approval_policy = "on-request"

[projects."/home/me/dev/secret"]
trust_level = "trusted"
`;

async function seedTargetMachineConfig(home: string): Promise<void> {
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.writeFile(path.join(home, ".codex/config.toml"), LIVE_TARGET_CONFIG);
}

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

/** Import the live config at `<homeA>/.codex` into a pack dir and serve it. */
async function importAndServePack(homeA: string): Promise<string> {
  const packDir = path.join(
    TMP_ROOT,
    `codex-pack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const imp = await run(
    [
      "import",
      path.join(homeA, ".codex"),
      "--from",
      "codex",
      "--id",
      PACK_ID,
      "--out",
      packDir,
    ],
    { HOME: homeA },
  );
  expect(imp.code, imp.stderr).toBe(0);
  fixture.sha = SHA_V1;
  await loadFixtureFromDir(packDir);
  return packDir;
}

function installArgs(extra: string[] = []): string[] {
  return [
    "install",
    `github:${OWNER}/${REPO}@main`,
    "--target",
    "codex",
    "--scope",
    "user",
    "--yes",
    ...extra,
  ];
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await startMockGitHub();
});

afterAll(async () => {
  server?.close();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("codex user scope — two-throwaway-HOME round trip (#132)", () => {
  it("import → install --scope user → verify → update → exec-gated update → uninstall", async () => {
    const homeA = await freshHome("codex-a");
    await seedLiveCodexConfig(homeA);
    await importAndServePack(homeA);

    // HOME B: the "second machine" with its own live codex config.
    const homeB = await freshHome("codex-b");
    await seedTargetMachineConfig(homeB);
    // Hooks + MCP servers are exec atoms → --allow-exec required (unsigned git source).
    const refusedInstall = await run(installArgs(), { HOME: homeB });
    expect(refusedInstall.code, refusedInstall.stderr + refusedInstall.stdout).toBe(6);
    const inst = await run(installArgs(["--allow-exec"]), { HOME: homeB });
    expect(inst.code, inst.stderr + inst.stdout).toBe(0);

    // User-layout mapping under ~/.codex — no .codex/.codex nesting, no .agents/.
    const codexB = path.join(homeB, ".codex");
    const agentsMd = await fs.readFile(path.join(codexB, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("Always leave a note.");
    const skill = await fs.readFile(path.join(codexB, "skills/greeting/SKILL.md"), "utf8");
    expect(skill).toContain("Say hello.");
    const hooks = JSON.parse(await fs.readFile(path.join(codexB, "hooks.json"), "utf8"));
    expect(JSON.stringify(hooks)).toContain("echo fmt-v1");
    await expect(fs.stat(path.join(codexB, ".codex"))).rejects.toThrow();
    await expect(fs.stat(path.join(codexB, ".agents"))).rejects.toThrow();
    await expect(fs.stat(path.join(homeB, ".agents"))).rejects.toThrow();

    // config.toml deep-merged: machine entries intact, pack MCP server added.
    const config = parseToml(
      await fs.readFile(path.join(codexB, "config.toml"), "utf8"),
    ) as Record<string, unknown>;
    expect(config["model"]).toBe("gpt-5.3-codex");
    expect(
      (config["projects"] as Record<string, Record<string, unknown>>)[
        "/home/me/dev/secret"
      ]["trust_level"],
    ).toBe("trusted");
    expect(
      (config["mcp_servers"] as Record<string, Record<string, unknown>>)["local-notes"][
        "command"
      ],
    ).toBe("notes-mcp");

    // State + provenance under ~/.codex/.agentpack/ — no project touched.
    const manifest = JSON.parse(
      await fs.readFile(path.join(codexB, `.agentpack/installed/${PACK_ID}.json`), "utf8"),
    );
    expect(manifest.scope).toBe("user");
    expect(manifest.target).toBe("codex");

    // Verify clean against ~/.codex.
    const v1 = await run(["verify", "--all", "--project", codexB], { HOME: homeB });
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
    expect(await fs.readFile(path.join(codexB, "AGENTS.md"), "utf8")).toContain(
      "Also water the plants.",
    );
    const v2 = await run(["verify", "--all", "--project", codexB], { HOME: homeB });
    expect(v2.code, v2.stderr + v2.stdout).toBe(0);

    // Pack edit #2: hook COMMAND change → exec-bearing delta. Refused without
    // a fresh --allow-exec even with --yes; applies with it. The command is
    // swapped in EVERY fixture file — the hook atom body AND the manifest's
    // permissions.shell.commands allow-list (the adapter refuses to emit a
    // hook whose command is not allow-listed).
    fixture.sha = SHA_V3;
    for (const [p, c] of fixture.files) {
      if (c.includes("echo fmt-v1")) {
        fixture.files.set(p, c.replaceAll("echo fmt-v1", "echo fmt-v2"));
      }
    }
    const refused = await run(["update", "--scope", "user", "--yes"], { HOME: homeB });
    expect(refused.code, refused.stderr + refused.stdout).toBe(6);
    expect(refused.stderr).toMatch(/allow-exec/i);
    // Refusal wrote nothing: the installed hook still says v1.
    expect(await fs.readFile(path.join(codexB, "hooks.json"), "utf8")).toContain("fmt-v1");

    const applied = await run(["update", "--scope", "user", "--yes", "--allow-exec"], {
      HOME: homeB,
    });
    expect(applied.code, applied.stderr + applied.stdout).toBe(0);
    expect(await fs.readFile(path.join(codexB, "hooks.json"), "utf8")).toContain("fmt-v2");
    const v3 = await run(["verify", "--all", "--project", codexB], { HOME: homeB });
    expect(v3.code, v3.stderr + v3.stdout).toBe(0);

    // Uninstall --scope user: pack files gone, machine config intact.
    const un = await run(["uninstall", PACK_ID, "--scope", "user", "--yes"], {
      HOME: homeB,
    });
    expect(un.code, un.stderr + un.stdout).toBe(0);
    // AGENTS.md was update-rewritten (backed up → tracked as `modified`), so
    // uninstall un-merges the pack span rather than unlinking; the pack's
    // content must be gone either way.
    const agentsAfter = await fs
      .readFile(path.join(codexB, "AGENTS.md"), "utf8")
      .catch(() => "");
    expect(agentsAfter).not.toContain("Always leave a note.");
    expect(agentsAfter).not.toContain("BEGIN AGENTPACK");
    await expect(fs.stat(path.join(codexB, "skills"))).rejects.toThrow();
    const afterConfig = parseToml(
      await fs.readFile(path.join(codexB, "config.toml"), "utf8"),
    ) as Record<string, unknown>;
    expect(afterConfig["model"]).toBe("gpt-5.3-codex");
    expect(
      (afterConfig["projects"] as Record<string, Record<string, unknown>>)[
        "/home/me/dev/secret"
      ]["trust_level"],
    ).toBe("trusted");
    expect(afterConfig["agentpack"]).toBeUndefined();
    expect(
      (afterConfig["mcp_servers"] as Record<string, unknown> | undefined)?.["local-notes"],
    ).toBeUndefined();
  }, 180_000);

  it("install --scope user --dry-run leaves an existing ~/.codex byte-identical", async () => {
    const homeA = await freshHome("codex-idry-a");
    await seedLiveCodexConfig(homeA);
    await importAndServePack(homeA);

    const homeB = await freshHome("codex-idry-b");
    await seedTargetMachineConfig(homeB);
    const before = await snapshotTree(homeB);
    const dry = await run(installArgs(["--dry-run", "--allow-exec"]), { HOME: homeB });
    expect(dry.code, dry.stderr + dry.stdout).toBe(0);
    const after = await snapshotTree(homeB);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  }, 120_000);

  it("update --scope user --dry-run leaves HOME byte-identical (exec-bearing delta pending)", async () => {
    const homeA = await freshHome("codex-udry-a");
    await seedLiveCodexConfig(homeA);
    await importAndServePack(homeA);

    const homeB = await freshHome("codex-udry-b");
    await seedTargetMachineConfig(homeB);
    const inst = await run(installArgs(["--allow-exec"]), { HOME: homeB });
    expect(inst.code, inst.stderr + inst.stdout).toBe(0);

    fixture.sha = SHA_V2;
    for (const [p, c] of fixture.files) {
      if (c.includes("echo fmt-v1")) {
        fixture.files.set(p, c.replaceAll("echo fmt-v1", "echo fmt-v2"));
      }
    }

    const before = await snapshotTree(homeB);
    const dry = await run(
      ["update", "--scope", "user", "--dry-run", "--yes", "--allow-exec"],
      {
        HOME: homeB,
      },
    );
    expect(dry.stdout).toContain("(--dry-run)");
    const after = await snapshotTree(homeB);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  }, 120_000);

  it("--force never implies --allow-exec: forced install of an exec-bearing pack still refuses (exit 6, zero writes)", async () => {
    const homeA = await freshHome("codex-force-a");
    await seedLiveCodexConfig(homeA);
    await importAndServePack(homeA);

    const homeB = await freshHome("codex-force-b");
    await seedTargetMachineConfig(homeB);
    // Seed a COLLIDING key so --force has a real conflict to authorize —
    // consent for overwrites must stay independent from consent for exec.
    await fs.appendFile(
      path.join(homeB, ".codex/config.toml"),
      `\n[mcp_servers.local-notes]\ncommand = "my-own-notes"\n`,
    );
    const before = await snapshotTree(homeB);
    const r = await run(installArgs(["--force"]), { HOME: homeB });
    expect(r.code, r.stderr + r.stdout).toBe(6);
    expect(r.stderr + r.stdout).toMatch(/allow-exec/i);
    const after = await snapshotTree(homeB);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());

    // WITH --allow-exec + --force, the collision deep-merges: pack wins ONLY
    // the collided key; the machine's other entries survive.
    const ok = await run(installArgs(["--force", "--allow-exec"]), { HOME: homeB });
    expect(ok.code, ok.stderr + ok.stdout).toBe(0);
    const config = parseToml(
      await fs.readFile(path.join(homeB, ".codex/config.toml"), "utf8"),
    ) as Record<string, unknown>;
    expect(
      (config["mcp_servers"] as Record<string, Record<string, unknown>>)["local-notes"][
        "command"
      ],
    ).toBe("notes-mcp");
    expect(config["model"]).toBe("gpt-5.3-codex");
  }, 120_000);

  it("install --scope user --dry-run with no ~/.codex fails cleanly and creates nothing", async () => {
    const homeA = await freshHome("codex-nodir-a");
    await seedLiveCodexConfig(homeA);
    await importAndServePack(homeA);

    const homeB = await freshHome("codex-nodir-b");
    const r = await run(installArgs(["--dry-run", "--allow-exec"]), { HOME: homeB });
    expect(r.code).not.toBe(0);
    await expect(fs.stat(path.join(homeB, ".codex"))).rejects.toThrow();
  });
});
