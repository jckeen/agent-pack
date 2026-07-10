// Sync S2 e2e gate (#111): the four scripted scenarios from
// docs/sync-design.md §7 driven against the REAL CLI and a local mock GitHub
// server — (a) clean update applies + verify clean; (b) local edit inside the
// marker span → refusal listing the path, --theirs applies with a restorable
// backup; (c) atom deleted upstream → its files removed, user files
// untouched; (d) upstream adds a hook → unsigned update refuses without
// --allow-exec even with --yes. Plus: --dry-run is zero-write, and pinned
// installs move only via --to.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-update-apply-${Date.now()}`);

const SHA_V1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_V2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const OWNER = "apply-owner";
const REPO = "apply-pack";
const PACK_ID = "fixture.apply-pack";

function manifestYaml(opts: {
  version: string;
  includeSkill?: boolean;
  includeHook?: boolean;
}): string {
  const atoms = [
    `  - id: "instruction:house"
    type: instruction
    name: "House Style"
    description: "A persistent instruction with no executable surface."
    path: "atoms/instructions/house.md"
    risk_level: low
    permissions: []`,
  ];
  if (opts.includeSkill ?? true) {
    atoms.push(`  - id: "skill:notes"
    type: skill
    name: "Notes"
    description: "A note-taking skill."
    path: "atoms/skills/notes"
    skill_format: "agentskills"
    risk_level: low
    permissions: []`);
  }
  if (opts.includeHook) {
    atoms.push(`  - id: "hook:post-edit"
    type: hook
    name: "Post Edit"
    description: "Runs a shell command after edits."
    path: "atoms/hooks/post-edit.yaml"
    risk_level: high
    permissions:
      - shell.execution
    lifecycle:
      events:
        generic:
          - after_edit`);
  }
  return `agentpack: "1.0"
metadata:
  id: "${PACK_ID}"
  name: "Apply Fixture Pack"
  slug: "apply-fixture-pack"
  description: "Test fixture for the sync S2 apply-path e2e gate."
  version: "${opts.version}"
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
  risk_level: ${opts.includeHook ? "high" : "low"}
  risk_summary: "${opts.includeHook ? "Ships a shell hook." : "Low — content only."}"
  requires_review: false
  signed: false
profiles:
  full:
    description: "Everything."
    include:
      - "*"
atoms:
${atoms.join("\n")}
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

const HOOK_YAML = `id: post-edit
name: Post Edit
events:
  generic:
    - after_edit
handler:
  kind: shell
  command: npm run format
permissions:
  - shell.execution
risk_level: high
warnings:
  - "Runs a shell command after file edits."
`;

function skillMd(body: string): string {
  return `---
name: notes
description: Use this skill to take notes.
---

${body}`;
}

function v1Tree(): Map<string, string> {
  return new Map([
    ["AGENTPACK.yaml", manifestYaml({ version: "0.1.0" })],
    ["atoms/instructions/house.md", "# House v1\n"],
    ["atoms/skills/notes/SKILL.md", skillMd("# Notes v1\n")],
  ]);
}

/** sha → repo tree. Tests mutate `current` and install the V2 shape they need. */
const trees = new Map<string, Map<string, string>>();
let currentSha = SHA_V1;

let server: http.Server;
let baseUrl: string;

function startMockGitHub(): Promise<void> {
  server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
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
      if (ref === "main") return json({ sha: currentSha });
      if (trees.has(ref)) return json({ sha: ref });
      return json({ message: "Not Found" }, 404);
    }
    if (p.startsWith(`/api/repos/${OWNER}/${REPO}/git/trees/`)) {
      const sha = decodeURIComponent(p.split("/git/trees/")[1] ?? "").replace(/\?.*$/, "");
      const tree = trees.get(sha);
      if (!tree) return json({ message: "Not Found" }, 404);
      return json({
        truncated: false,
        tree: [...tree.keys()].map((f) => ({ path: f, type: "blob" })),
      });
    }
    const rawPrefix = `/raw/${OWNER}/${REPO}/`;
    if (p.startsWith(rawPrefix)) {
      const rest = decodeURIComponent(p.slice(rawPrefix.length));
      const slash = rest.indexOf("/");
      const sha = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      const body = trees.get(sha)?.get(file);
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

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
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

/** Install v1 from the mock repo @main. */
async function installV1(dir: string): Promise<void> {
  currentSha = SHA_V1;
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
}

/** Advance main to SHA_V2 with the given tree mutations over v1. */
function advance(mutate: (tree: Map<string, string>) => void): void {
  const tree = v1Tree();
  mutate(tree);
  trees.set(SHA_V2, tree);
  currentSha = SHA_V2;
}

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

beforeEach(() => {
  trees.clear();
  trees.set(SHA_V1, v1Tree());
  currentSha = SHA_V1;
});

afterAll(async () => {
  server?.close();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("sync S2 — update apply path (e2e gate for #111)", () => {
  it("(a) clean update applies, verify clean, provenance + manifest advanced", async () => {
    const dir = await freshProject("clean-update");
    await installV1(dir);
    advance((t) => {
      t.set("AGENTPACK.yaml", manifestYaml({ version: "0.2.0" }));
      t.set("atoms/instructions/house.md", "# House v2\n");
    });

    const r = await run(["update", "--project", dir, "--yes"]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("House v2");

    const v = await run(["verify", PACK_ID, "--project", dir]);
    expect(v.code, v.stderr + v.stdout).toBe(0);

    const lock = JSON.parse(await fs.readFile(path.join(dir, "AGENTPACK.lock"), "utf8"));
    expect(lock.source.resolvedSha).toBe(SHA_V2);
    expect(lock.packVersion).toBe("0.2.0");

    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, `.agentpack/installed/${PACK_ID}.json`), "utf8"),
    );
    expect(manifest.previousPackVersion).toBe("0.1.0");
    expect(manifest.updatedAt).toBeTruthy();
    expect(manifest.source.resolvedSha).toBe(SHA_V2);
  });

  it("(b) local edit inside the marker span refuses listing the path; --theirs applies with a restorable backup", async () => {
    const dir = await freshProject("span-conflict");
    await installV1(dir);
    const agentsPath = path.join(dir, "AGENTS.md");
    const edited = (await fs.readFile(agentsPath, "utf8")).replace(
      "House v1",
      "House v1 EDITED",
    );
    await fs.writeFile(agentsPath, edited, "utf8");
    advance((t) => {
      t.set("AGENTPACK.yaml", manifestYaml({ version: "0.2.0" }));
      t.set("atoms/instructions/house.md", "# House v2\n");
    });

    const refused = await run(["update", "--project", dir, "--yes"]);
    expect(refused.code, refused.stderr + refused.stdout).toBe(2);
    expect(refused.stderr + refused.stdout).toContain("AGENTS.md");
    // Refusal touched nothing.
    expect(await fs.readFile(agentsPath, "utf8")).toBe(edited);

    const theirs = await run([
      "update",
      "--project",
      dir,
      "--yes",
      "--theirs",
      "AGENTS.md",
    ]);
    expect(theirs.code, theirs.stderr + theirs.stdout).toBe(0);
    const after = await fs.readFile(agentsPath, "utf8");
    expect(after).toContain("House v2");
    expect(after).not.toContain("EDITED");
    // The clobbered local edit is restorable.
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, `.agentpack/installed/${PACK_ID}.json`), "utf8"),
    );
    const backup = manifest.backups.find(
      (b: { original: string }) => b.original === "AGENTS.md",
    );
    expect(backup).toBeTruthy();
    expect(await fs.readFile(path.join(dir, backup.backupPath), "utf8")).toContain(
      "EDITED",
    );
  });

  it("(c) upstream-deleted atom's files are removed; user files untouched", async () => {
    const dir = await freshProject("upstream-delete");
    await installV1(dir);
    const userFile = path.join(dir, "skills/notes/my-notes.md");
    await fs.writeFile(userFile, "mine\n", "utf8");
    advance((t) => {
      t.set("AGENTPACK.yaml", manifestYaml({ version: "0.2.0", includeSkill: false }));
      t.set("atoms/instructions/house.md", "# House v2\n");
      t.delete("atoms/skills/notes/SKILL.md");
    });

    const r = await run(["update", "--project", dir, "--yes"]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    await expect(fs.access(path.join(dir, "skills/notes/SKILL.md"))).rejects.toThrow();
    expect(await fs.readFile(userFile, "utf8")).toBe("mine\n");
  });

  it("(d) upstream-added hook refuses without --allow-exec even with --yes; --allow-exec proceeds", async () => {
    const dir = await freshProject("hook-added");
    await installV1(dir);
    advance((t) => {
      t.set("AGENTPACK.yaml", manifestYaml({ version: "0.2.0", includeHook: true }));
      t.set("atoms/hooks/post-edit.yaml", HOOK_YAML);
    });

    const refused = await run(["update", "--project", dir, "--yes"]);
    expect(refused.code, refused.stderr + refused.stdout).toBe(6);
    expect(refused.stderr + refused.stdout).toMatch(/allow-exec/);

    const allowed = await run(["update", "--project", dir, "--yes", "--allow-exec"]);
    expect(allowed.code, allowed.stderr + allowed.stdout).toBe(0);
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, `.agentpack/installed/${PACK_ID}.json`), "utf8"),
    );
    expect(manifest.atomIds).toContain("hook:post-edit");
  });

  it("--dry-run reports the plan and writes nothing", async () => {
    const dir = await freshProject("dry-run");
    await installV1(dir);
    advance((t) => {
      t.set("AGENTPACK.yaml", manifestYaml({ version: "0.2.0" }));
      t.set("atoms/instructions/house.md", "# House v2\n");
    });
    const before = await snapshotTree(dir);
    const r = await run(["update", "--project", dir, "--dry-run"]);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain("AGENTS.md");
    const after = await snapshotTree(dir);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  });

  it("a SHA-pinned install does not move on bare update; --to moves it", async () => {
    const dir = await freshProject("pinned-move");
    currentSha = SHA_V1;
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
    advance((t) => {
      t.set("AGENTPACK.yaml", manifestYaml({ version: "0.2.0" }));
      t.set("atoms/instructions/house.md", "# House v2\n");
    });

    const noop = await run(["update", "--project", dir, "--yes"]);
    expect(noop.code, noop.stderr + noop.stdout).toBe(0);
    expect(noop.stdout).toContain("pinned");
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("House v1");

    const moved = await run(["update", "--project", dir, "--yes", "--to", SHA_V2]);
    expect(moved.code, moved.stderr + moved.stdout).toBe(0);
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain("House v2");
    const lock = JSON.parse(await fs.readFile(path.join(dir, "AGENTPACK.lock"), "utf8"));
    expect(lock.source.resolvedSha).toBe(SHA_V2);
    expect(lock.source.requestedRef).toBe(SHA_V2);
  });
});
