// #132: generic user scope — the Antigravity runtime profile. Antigravity's
// global customization root is `~/.gemini/config/` ("Global Discovery",
// verified against agy 1.1.3): it reads standalone AGENTS.md rule files and
// `skills/` folders directly in that root — exactly the generic adapter's
// layout, so `install --target generic --scope user` maps 1:1 with no
// dedicated adapter.
//
// Two-throwaway-HOME round trip mirroring the claude-code S3 gate:
// install → verify → update → dry-run-zero-writes → uninstall, plus the
// consent pins: --force never implies --allow-exec, and a pre-existing
// GEMINI.md / mcp_config.json / user skills are never touched.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const TMP_ROOT = path.join(os.tmpdir(), `agentpack-user-generic-${Date.now()}`);

const SHA_V1 = "1111111111111111111111111111111111111111";
const SHA_V2 = "2222222222222222222222222222222222222222";
const OWNER = "fixture-owner";
const REPO = "fixture-agy-pack";
const PACK_ID = "fixture.agy-pack";

function manifestYaml(version: string, opts: { withHook?: boolean } = {}): string {
  const hookAtom = opts.withHook
    ? `  - id: "hook:post-edit-format"
    type: hook
    name: "Post Edit Format"
    description: "Runs a formatter after edits."
    path: "atoms/hooks/post-edit-format.yaml"
    risk_level: high
    permissions:
      - shell.execution
`
    : "";
  const shellPerm = opts.withHook
    ? `  shell:
    execution: "optional"
    commands:
      - "echo fmt-v1"
`
    : "";
  return `agentpack: "1.0"
metadata:
  id: "${PACK_ID}"
  name: "Agy Fixture Pack"
  slug: "agy-fixture-pack"
  description: "Test fixture for the generic (Antigravity) user-scope e2e gate."
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
${shellPerm}  package_installation: false
  model_provider_key_access: false
security:
  risk_level: ${opts.withHook ? "high" : "low"}
  risk_summary: "Fixture."
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
  - id: "skill:greeting"
    type: skill
    name: "Greeting"
    description: "Greets politely."
    path: "atoms/skills/greeting"
    risk_level: low
    permissions: []
${hookAtom}exports:
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

const HOOK_ATOM_YAML = `id: post-edit-format
name: Post Edit Format
events:
  generic:
    - after_edit
handler:
  kind: shell
  command: echo fmt-v1
permissions:
  - shell.execution
risk_level: high
`;

const SKILL_MD =
  "---\nname: greeting\ndescription: Greets politely.\n---\n\n# Greeting\n\nSay hello.\n";

/** Mutable fixture state. */
const fixture = { sha: SHA_V1, files: new Map<string, string>() };

function resetFixture(opts: { withHook?: boolean } = {}): void {
  fixture.sha = SHA_V1;
  fixture.files.clear();
  fixture.files.set("AGENTPACK.yaml", manifestYaml("0.1.0", opts));
  fixture.files.set("atoms/instructions/notes.md", "# Notes\n\nAlways leave a note.\n");
  fixture.files.set("atoms/skills/greeting/SKILL.md", SKILL_MD);
  if (opts.withHook) {
    fixture.files.set("atoms/hooks/post-edit-format.yaml", HOOK_ATOM_YAML);
  }
}

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
      if ([SHA_V1, SHA_V2].includes(ref)) return json({ sha: ref });
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

/** Seed a live Antigravity global config the install must coexist with. */
async function seedLiveAntigravityConfig(home: string): Promise<string> {
  const configDir = path.join(home, ".gemini", "config");
  await fs.mkdir(path.join(configDir, "skills/my-own-skill"), { recursive: true });
  await fs.writeFile(
    path.join(configDir, "GEMINI.md"),
    "# My Global Guidance\n\nMy own rules.\n",
  );
  await fs.writeFile(
    path.join(configDir, "mcp_config.json"),
    JSON.stringify({ mcpServers: { mine: { command: "my-mcp" } } }),
  );
  await fs.writeFile(
    path.join(configDir, "skills/my-own-skill/SKILL.md"),
    "---\nname: my-own-skill\ndescription: Mine.\n---\n\nMine.\n",
  );
  // The user also keeps their own AGENTS.md — the pack must marker-merge in.
  await fs.writeFile(path.join(configDir, "AGENTS.md"), "# Mine\n\nMy own AGENTS notes.\n");
  return configDir;
}

function installArgs(extra: string[] = []): string[] {
  return [
    "install",
    `github:${OWNER}/${REPO}@main`,
    "--target",
    "generic",
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

beforeEach(() => resetFixture());

afterAll(async () => {
  server?.close();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("generic user scope — Antigravity profile round trip (#132)", () => {
  it("install → verify → update → uninstall against ~/.gemini/config, coexisting with live config", async () => {
    const home = await freshHome("agy-roundtrip");
    const configDir = await seedLiveAntigravityConfig(home);

    const inst = await run(installArgs(), { HOME: home });
    expect(inst.code, inst.stderr + inst.stdout).toBe(0);

    // Pack output landed in the Antigravity global customization root.
    const agentsMd = await fs.readFile(path.join(configDir, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("My own AGENTS notes."); // user content survives
    expect(agentsMd).toContain("Always leave a note."); // pack block merged in
    const skill = await fs.readFile(
      path.join(configDir, "skills/greeting/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("Say hello.");

    // Live Antigravity config untouched: GEMINI.md, mcp_config.json, own skills.
    expect(await fs.readFile(path.join(configDir, "GEMINI.md"), "utf8")).toContain(
      "My own rules.",
    );
    expect(await fs.readFile(path.join(configDir, "mcp_config.json"), "utf8")).toContain(
      "my-mcp",
    );
    expect(
      await fs.readFile(path.join(configDir, "skills/my-own-skill/SKILL.md"), "utf8"),
    ).toContain("Mine.");

    // State + provenance under ~/.gemini/config/.agentpack/.
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(configDir, `.agentpack/installed/${PACK_ID}.json`),
        "utf8",
      ),
    );
    expect(manifest.scope).toBe("user");
    expect(manifest.target).toBe("generic");

    const v1 = await run(["verify", "--all", "--project", configDir], { HOME: home });
    expect(v1.code, v1.stderr + v1.stdout).toBe(0);

    // Pack edit → update --scope user picks it up from the ~/.gemini/config
    // root. Other user roots exist WITHOUT AgentPack state — the multi-root
    // scan must tolerate them silently.
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    fixture.sha = SHA_V2;
    fixture.files.set(
      "atoms/instructions/notes.md",
      "# Notes\n\nAlways leave a note.\n\nAlso water the plants.\n",
    );
    const up = await run(["update", "--scope", "user", "--yes"], { HOME: home });
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect(await fs.readFile(path.join(configDir, "AGENTS.md"), "utf8")).toContain(
      "Also water the plants.",
    );
    const v2 = await run(["verify", "--all", "--project", configDir], { HOME: home });
    expect(v2.code, v2.stderr + v2.stdout).toBe(0);

    // Uninstall: pack files gone, the user's own config intact.
    const un = await run(["uninstall", PACK_ID, "--scope", "user", "--yes"], {
      HOME: home,
    });
    expect(un.code, un.stderr + un.stdout).toBe(0);
    const agentsAfter = await fs.readFile(path.join(configDir, "AGENTS.md"), "utf8");
    expect(agentsAfter).toContain("My own AGENTS notes.");
    expect(agentsAfter).not.toContain("Always leave a note.");
    await expect(fs.stat(path.join(configDir, "skills/greeting"))).rejects.toThrow();
    expect(
      await fs.readFile(path.join(configDir, "skills/my-own-skill/SKILL.md"), "utf8"),
    ).toContain("Mine.");
    expect(await fs.readFile(path.join(configDir, "GEMINI.md"), "utf8")).toContain(
      "My own rules.",
    );
  }, 180_000);

  it("install --scope user --dry-run leaves an existing ~/.gemini/config byte-identical", async () => {
    const home = await freshHome("agy-idry");
    await seedLiveAntigravityConfig(home);
    const before = await snapshotTree(home);
    const dry = await run(installArgs(["--dry-run"]), { HOME: home });
    expect(dry.code, dry.stderr + dry.stdout).toBe(0);
    const after = await snapshotTree(home);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  }, 120_000);

  it("update --scope user --dry-run leaves HOME byte-identical", async () => {
    const home = await freshHome("agy-udry");
    await seedLiveAntigravityConfig(home);
    const inst = await run(installArgs(), { HOME: home });
    expect(inst.code, inst.stderr + inst.stdout).toBe(0);

    fixture.sha = SHA_V2;
    fixture.files.set(
      "atoms/instructions/notes.md",
      "# Notes\n\nAlways leave a note.\n\nAlso water the plants.\n",
    );
    const before = await snapshotTree(home);
    const dry = await run(["update", "--scope", "user", "--dry-run", "--yes"], {
      HOME: home,
    });
    expect(dry.stdout).toContain("(--dry-run)");
    const after = await snapshotTree(home);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  }, 120_000);

  it("--force never implies --allow-exec: a hook-bearing pack refuses without --allow-exec even with --force --yes", async () => {
    resetFixture({ withHook: true });
    const home = await freshHome("agy-force");
    await seedLiveAntigravityConfig(home);
    const before = await snapshotTree(home);
    const r = await run(installArgs(["--force"]), { HOME: home });
    expect(r.code, r.stderr + r.stdout).toBe(6);
    expect(r.stderr + r.stdout).toMatch(/allow-exec/i);
    const after = await snapshotTree(home);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());

    const ok = await run(installArgs(["--force", "--allow-exec"]), { HOME: home });
    expect(ok.code, ok.stderr + ok.stdout).toBe(0);
  }, 120_000);

  it("install --scope user creates ~/.gemini/config when missing (fresh machine)", async () => {
    const home = await freshHome("agy-fresh");
    const inst = await run(installArgs(), { HOME: home });
    expect(inst.code, inst.stderr + inst.stdout).toBe(0);
    const configDir = path.join(home, ".gemini", "config");
    expect(await fs.readFile(path.join(configDir, "AGENTS.md"), "utf8")).toContain(
      "Always leave a note.",
    );
    // update --check --scope user finds the install without any --project.
    fixture.sha = SHA_V2;
    fixture.files.set("atoms/instructions/notes.md", "# Notes v2\n");
    const chk = await run(["update", "--scope", "user", "--check"], { HOME: home });
    expect(chk.code, chk.stderr + chk.stdout).toBe(10);
  }, 120_000);
});
