// Regression gate for #133 × #162: `agentpack publish` collects target-variant
// files through the SAME containment + symlink trust boundary as default atom
// paths (`resolveInsidePack`) — one gate, no second implementation.
//
// Failure modes pinned here (mirroring publish-containment.cli.test.ts):
//  - a `variants[<target>].path` with `..` traversal is refused up front by
//    validateManifest (the schema applies atom.path trust rules to variant
//    paths), before any network IO;
//  - a schema-valid variant path that is a SYMLINK pointing outside the pack
//    must refuse via the containment gate — this is the case that genuinely
//    exercises `resolveInsidePack` on a variant path, since the lexical
//    traversal above never reaches collectFiles;
//  - a valid pack with a variant publishes end-to-end and the variant FILE is
//    uploaded alongside the default source.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-publish-variant-cli-${Date.now()}`);
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

function manifestYaml(variantPath: string): string {
  return `agentpack: "1.0"
metadata:
  id: "fixture.variant-pack"
  name: "Variant Fixture Pack"
  slug: "variant-fixture-pack"
  description: "Test fixture for the #133 variant-path publish containment gate."
  version: "0.1.0"
  license: "MIT"
  publisher: "fixture"
compatibility:
  targets:
    generic:
      status: supported
    codex:
      status: supported
security:
  risk_level: low
profiles:
  full:
    description: "Everything."
    include:
      - "*"
atoms:
  - id: "instruction:notes"
    type: instruction
    name: "Notes"
    description: "Instruction whose codex body is a target variant."
    path: "atoms/notes.md"
    risk_level: low
    permissions: []
    variants:
      codex:
        path: "${variantPath}"
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
          url: `${registryUrl}/packs/fixture/variant-fixture-pack`,
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
 *   TMP_ROOT/<name>/pack/AGENTPACK.yaml (default atom body always present)
 * Returns the pack directory.
 */
async function makePack(name: string, variantPath: string): Promise<string> {
  const caseRoot = path.join(TMP_ROOT, name);
  const packDir = path.join(caseRoot, "pack");
  await fs.mkdir(path.join(packDir, "atoms"), { recursive: true });
  await fs.writeFile(path.join(caseRoot, "outside-secret.md"), SECRET_CONTENT);
  await fs.writeFile(path.join(packDir, "AGENTPACK.yaml"), manifestYaml(variantPath));
  await fs.writeFile(path.join(packDir, "atoms", "notes.md"), "# Notes (default)\n");
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

describe("agentpack publish — variant-path containment gate (#133)", () => {
  it("refuses a variant path that traverses outside the pack (schema gate)", async () => {
    const packDir = await makePack("variant-traversal", "../outside-secret.md");
    const r = await run(publishArgs(packDir), packDir);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/invalid/i);
    // Refusal happens at validateManifest, before any network IO.
    expect(requests).toHaveLength(0);
  });

  it("refuses a symlink variant path pointing outside the pack (containment gate)", async () => {
    // Lexically clean path, hostile on disk — this is the case that reaches
    // collectFiles and exercises resolveInsidePack on the VARIANT path.
    const packDir = await makePack("variant-symlink", "atoms/notes.codex.md");
    await fs.symlink(
      path.join(packDir, "..", "outside-secret.md"),
      path.join(packDir, "atoms", "notes.codex.md"),
    );
    const r = await run(publishArgs(packDir), packDir);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/escapes the pack root/i);
    expect(requests).toHaveLength(0);
  });

  it("publishes a valid variant pack and uploads the variant file", async () => {
    const packDir = await makePack("variant-valid", "atoms/notes.codex.md");
    await fs.writeFile(path.join(packDir, "atoms", "notes.codex.md"), "# Notes (codex)\n");
    const r = await run(publishArgs(packDir), packDir);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const init = requests.find((q) => q.path === "/api/publish/init");
    expect(init).toBeDefined();
    const declared = (JSON.parse(init!.body) as { files: Array<{ path: string }> }).files
      .map((f) => f.path)
      .sort();
    expect(declared).toContain("atoms/notes.md");
    expect(declared).toContain("atoms/notes.codex.md");
    // The variant blob itself was uploaded.
    expect(
      requests.some(
        (q) =>
          q.method === "PUT" &&
          q.path === `/blob/${encodeURIComponent("atoms/notes.codex.md")}`,
      ),
    ).toBe(true);
    // The outside secret never crossed the wire.
    expect(requests.every((q) => !q.body.includes("TOP-SECRET"))).toBe(true);
  });
});
