// #149: three output-accuracy fixes in install/uninstall plan+result reporting:
//   (a) the pre-consent git line says "Fetched from git" (nothing is installed
//       at that point — it's materialization into a tmpdir), asserted on the
//       one mode that promises zero mutation (--dry-run);
//   (b) the result line reconciles with the plan: "N files + lockfile written"
//       where N equals the plan's Create count;
//   (c) the uninstall plan lists a merged CLAUDE.md only under Unmerge, never
//       doubled under Remove.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXAMPLE = path.resolve(REPO_ROOT, "examples/pr-quality");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-output-accuracy-${Date.now()}`);

const OWNER = "accuracy-owner";
const REPO = "accuracy-pack";
const SHA = "cccccccccccccccccccccccccccccccccccccccc";

const MANIFEST_YAML = `agentpack: "1.0"
metadata:
  id: "fixture.accuracy-pack"
  name: "Accuracy Fixture Pack"
  slug: "accuracy-fixture-pack"
  description: "Test fixture for output-accuracy assertions."
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
  risk_summary: "Low — content only."
  requires_review: false
  signed: false
profiles:
  full:
    description: "Everything."
    include:
      - "*"
atoms:
  - id: "instruction:house"
    type: instruction
    name: "House Style"
    description: "A persistent instruction with no executable surface."
    path: "atoms/instructions/house.md"
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

const TREE = new Map<string, string>([
  ["AGENTPACK.yaml", MANIFEST_YAML],
  ["atoms/instructions/house.md", "# House style\n"],
]);

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
      return json({ sha: SHA });
    }
    if (p.startsWith(`/api/repos/${OWNER}/${REPO}/git/trees/`)) {
      return json({
        truncated: false,
        tree: [...TREE.keys()].map((f) => ({ path: f, type: "blob" })),
      });
    }
    const rawPrefix = `/raw/${OWNER}/${REPO}/`;
    if (p.startsWith(rawPrefix)) {
      const rest = decodeURIComponent(p.slice(rawPrefix.length));
      const file = rest.slice(rest.indexOf("/") + 1);
      const body = TREE.get(file);
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
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
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

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await startMockGitHub();
});

afterAll(async () => {
  server?.close();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("install/uninstall output accuracy (#149)", () => {
  it("dry-run git install says Fetched, not Installed (a)", async () => {
    const dir = await freshProject("git-dry-run");
    const r = await run([
      "install",
      `github:${OWNER}/${REPO}@main`,
      "--target",
      "generic",
      "--project",
      dir,
      "--dry-run",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Fetched from git:");
    expect(r.stdout).not.toContain("Installed from git:");
  });

  it("result line reconciles with the plan's Create count (b)", async () => {
    const dir = await freshProject("count-reconcile");
    const r = await run([
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
    expect(r.code).toBe(0);
    const createMatch = r.stdout.match(/Create \((\d+)\):/);
    expect(createMatch).not.toBeNull();
    expect(r.stdout).toContain(`• ${createMatch?.[1]} files + lockfile written.`);
    expect(r.stdout).not.toMatch(/\d+ files written\./);
  });

  it("uninstall plan lists merged CLAUDE.md only under Unmerge (c)", async () => {
    const dir = await freshProject("unmerge-once");
    const inst = await run([
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
    expect(inst.code).toBe(0);
    // No --yes and no TTY: the CLI prints the plan then refuses at the
    // confirmation step — a zero-mutation way to inspect the plan.
    const r = await run(["uninstall", "agentpack.pr-quality", "--project", dir]);
    expect(r.stdout).toContain("✂ CLAUDE.md (marker)");
    expect(r.stdout).not.toMatch(/−\s+CLAUDE\.md/);
    // The Remove count excludes the merged file (4 created, 1 is the merge).
    expect(r.stdout).toContain("Remove (3):");
  });
});
