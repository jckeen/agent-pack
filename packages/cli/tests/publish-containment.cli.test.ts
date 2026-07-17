// Regression gate for #162: `agentpack publish` must route every
// manifest-declared atom path through the same containment + symlink trust
// boundary the adapters use (`resolveInsidePack`), and must refuse to publish
// an invalid manifest at all.
//
// Failure modes pinned here:
//  - a manifest with `path: ../../outside-secret` must refuse to publish
//    (schema gate: validateManifest rejects `..` traversal);
//  - a schema-valid path that is a SYMLINK pointing outside the pack must
//    refuse (containment gate: resolveInsidePack);
//  - a symlink nested inside a directory atom must refuse;
//  - a valid pack still publishes end-to-end against a mock registry.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-publish-cli-${Date.now()}`);
const SECRET_CONTENT = "TOP-SECRET outside-the-pack content\n";

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_ENTRY, ...args], {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        AGENTPACK_TOKEN: "test-token",
        AGENTPACK_HOME: path.join(TMP_ROOT, "agentpack-home"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function manifestYaml(atomPath: string): string {
  return `agentpack: "1.0"
metadata:
  id: "fixture.publish-pack"
  name: "Publish Fixture Pack"
  slug: "publish-fixture-pack"
  description: "Test fixture for the #162 publish containment gate."
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
    path: "${atomPath}"
    risk_level: low
    permissions: []
exports:
  default_profile: full
`;
}

/** Mock registry: records every request so tests can assert nothing leaked. */
interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

let server: http.Server;
let registryUrl: string;
let requests: RecordedRequest[];

function startMockRegistry(): Promise<void> {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const p = req.url ?? "/";
      requests.push({ method: req.method ?? "", path: p, body });
      const json = (payload: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && p === "/api/publish/init") {
        const parsed = JSON.parse(body) as {
          files: Array<{ path: string }>;
        };
        const uploads = [
          { path: "AGENTPACK.yaml" },
          ...parsed.files.map((f) => ({ path: f.path })),
        ].map((f) => ({
          path: f.path,
          url: `${registryUrl}/blob/${encodeURIComponent(f.path)}`,
          headers: {},
        }));
        return json({
          publishId: "pub-1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          presignedUploads: uploads,
        });
      }
      if (req.method === "PUT" && p.startsWith("/blob/")) {
        return json({ ok: true });
      }
      if (req.method === "POST" && p === "/api/publish/pub-1/finalize") {
        return json({
          packId: "pack-1",
          versionId: "ver-1",
          url: `${registryUrl}/packs/fixture/publish-fixture-pack`,
        });
      }
      return json({ error: `unexpected ${req.method} ${p}` }, 500);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        registryUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
}

/**
 * Lay out:
 *   TMP_ROOT/<name>/outside-secret.md   <- must never be uploaded
 *   TMP_ROOT/<name>/pack/AGENTPACK.yaml
 *   TMP_ROOT/<name>/pack/...
 * Returns the pack directory.
 */
async function makePack(name: string, atomPath: string): Promise<string> {
  const caseRoot = path.join(TMP_ROOT, name);
  const packDir = path.join(caseRoot, "pack");
  await fs.mkdir(path.join(packDir, "atoms"), { recursive: true });
  await fs.writeFile(path.join(caseRoot, "outside-secret.md"), SECRET_CONTENT);
  await fs.writeFile(path.join(packDir, "AGENTPACK.yaml"), manifestYaml(atomPath));
  return packDir;
}

function publishArgs(packDir: string): string[] {
  return ["publish", packDir, "--registry", registryUrl, "--yes", "--no-sign"];
}

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await startMockRegistry();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
});

describe("agentpack publish — containment gate (#162)", () => {
  it("refuses a manifest whose atom path traverses outside the pack", async () => {
    const packDir = await makePack("traversal", "../outside-secret.md");
    const r = await run(publishArgs(packDir), packDir);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/invalid/i);
    // Nothing may reach the registry — refusal happens before any network IO.
    expect(requests).toHaveLength(0);
  });

  it("refuses a symlink atom path pointing outside the pack", async () => {
    const packDir = await makePack("symlink-direct", "atoms/link.md");
    await fs.symlink(
      path.join(packDir, "..", "outside-secret.md"),
      path.join(packDir, "atoms", "link.md"),
    );
    const r = await run(publishArgs(packDir), packDir);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/escapes the pack root/i);
    expect(requests).toHaveLength(0);
  });

  it("refuses a symlink nested inside a directory atom", async () => {
    const packDir = await makePack("symlink-nested", "atoms/skill");
    const skillDir = path.join(packDir, "atoms", "skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Skill\n");
    await fs.symlink(
      path.join(packDir, "..", "outside-secret.md"),
      path.join(skillDir, "evil.md"),
    );
    const r = await run(publishArgs(packDir), packDir);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/escapes the pack root/i);
    expect(requests).toHaveLength(0);
  });

  it("refuses an invalid manifest before any network IO", async () => {
    const packDir = path.join(TMP_ROOT, "invalid", "pack");
    await fs.mkdir(packDir, { recursive: true });
    // Structurally broken: missing metadata.version (among others).
    await fs.writeFile(
      path.join(packDir, "AGENTPACK.yaml"),
      `agentpack: "1.0"\nmetadata:\n  name: "Broken"\nprofiles: {}\natoms: []\n`,
    );
    const r = await run(publishArgs(packDir), packDir);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/invalid/i);
    expect(requests).toHaveLength(0);
  });

  it("still publishes a valid pack end-to-end", async () => {
    const packDir = await makePack("valid", "atoms/notes.md");
    await fs.writeFile(path.join(packDir, "atoms", "notes.md"), "# Notes\n");
    const r = await run(publishArgs(packDir), packDir);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ Published fixture/publish-fixture-pack@0.1.0");
    const paths = requests.map((q) => `${q.method} ${q.path}`);
    expect(paths).toContain("POST /api/publish/init");
    expect(paths).toContain(`PUT /blob/${encodeURIComponent("AGENTPACK.yaml")}`);
    expect(paths).toContain(`PUT /blob/${encodeURIComponent("atoms/notes.md")}`);
    expect(paths).toContain("POST /api/publish/pub-1/finalize");
    // The out-of-pack secret must never appear in any request body.
    for (const q of requests) {
      expect(q.body).not.toContain("TOP-SECRET");
    }
  });
});
