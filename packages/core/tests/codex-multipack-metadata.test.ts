// #192: two otherwise-disjoint Codex packs must coexist in one config.toml.
// The adapter used to emit a singleton `[agentpack]` table with the same keys
// for every pack, so the second install collided on metadata alone, --force
// overwrote the first pack's provenance (drift), and uninstalling the second
// removed the shared table. Metadata is now namespaced per pack.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  planInstall,
  applyInstall,
  verifyInstall,
  uninstall,
  resolveAgentpackPaths,
  readInstallManifest,
} from "../src/install/index.js";
import { planUpdate, applyUpdate } from "../src/install/update.js";
import {
  mergeTomlConfig,
  removeTomlFragment,
  tomlFragmentIntact,
} from "../src/install/merge.js";

const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Minimal codex-target pack: one instruction + one declared MCP server. */
async function writeCodexPack(
  dir: string,
  opts: { id: string; slug: string; server: string },
): Promise<void> {
  await fs.writeFile(
    path.join(dir, "AGENTPACK.yaml"),
    `agentpack: "1.0"
metadata:
  id: "${opts.id}"
  name: "Fixture ${opts.slug}"
  slug: "${opts.slug}"
  description: "Multi-pack codex metadata fixture."
  version: "1.0.0"
  license: "MIT"
  publisher: "fixture"
compatibility:
  targets:
    codex:
      status: supported
permissions:
  mcp:
    servers:
      - "${opts.server}"
  network:
    access: optional
  external_apis:
    - "${opts.server}"
security:
  risk_level: high
  risk_summary: "MCP server."
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
    description: "A persistent instruction."
    path: "atoms/instructions/house.md"
    risk_level: low
    permissions: []
  - id: "mcp_server:${opts.server}"
    type: mcp_server
    name: "${opts.server} MCP"
    description: "An MCP server."
    path: "atoms/mcp/${opts.server}.yaml"
    risk_level: high
    permissions:
      - network.access
      - external_api.access
    transport: stdio
    command: "${opts.server}-mcp"
exports:
  default_profile: full
`,
    "utf8",
  );
  await fs.mkdir(path.join(dir, "atoms/instructions"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "atoms/instructions/house.md"),
    `# House\n\nInstruction for ${opts.slug}.\n`,
    "utf8",
  );
  await fs.mkdir(path.join(dir, "atoms/mcp"), { recursive: true });
  await fs.writeFile(
    path.join(dir, `atoms/mcp/${opts.server}.yaml`),
    `id: ${opts.server}\nname: ${opts.server} MCP\ntransport: stdio\ncommand: ${opts.server}-mcp\n`,
    "utf8",
  );
}

async function fixtures(): Promise<{ root: string; packA: string; packB: string }> {
  const root = await tempDir("agentpack-codex-multi-root-");
  await fs.writeFile(
    path.join(root, "config.toml"),
    `model = "gpt-5.3-codex"\n\n[projects."/home/me/dev/secret"]\ntrust_level = "trusted"\n`,
    "utf8",
  );
  const packA = await tempDir("agentpack-codex-multi-a-");
  const packB = await tempDir("agentpack-codex-multi-b-");
  await writeCodexPack(packA, { id: "fixture.alpha", slug: "alpha", server: "alpha" });
  await writeCodexPack(packB, { id: "fixture.beta", slug: "beta", server: "beta" });
  return { root, packA, packB };
}

function plan(source: string, root: string) {
  return planInstall({
    source,
    target: "codex",
    profile: "full" as never,
    projectRoot: root,
    scope: "user",
    generator: GEN,
  });
}

async function readConfig(root: string): Promise<Record<string, unknown>> {
  return parseToml(await fs.readFile(path.join(root, "config.toml"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("codex per-pack metadata (#192)", () => {
  it("updates one pack while preserving the other pack and user settings", async () => {
    const { root, packA, packB } = await fixtures();
    try {
      await applyInstall({ plan: await plan(packA, root), actor: { type: "cli" } });
      await applyInstall({ plan: await plan(packB, root), actor: { type: "cli" } });
      const before = await readConfig(root);
      const ws = await resolveAgentpackPaths(root);
      const priorManifest = await readInstallManifest(ws, "fixture.alpha");
      const manifestPath = path.join(packA, "AGENTPACK.yaml");
      const manifest = await fs.readFile(manifestPath, "utf8");
      await fs.writeFile(manifestPath, manifest.replace('version: "1.0.0"', 'version: "1.1.0"'));
      await fs.writeFile(path.join(packA, "atoms/instructions/house.md"), "# Updated alpha\n");
      const update = await planUpdate({ newPlan: await plan(packA, root), priorManifest });
      expect(update.conflicts).toEqual([]);
      await applyUpdate({ update, actor: { type: "cli" } });
      const after = await readConfig(root);
      expect(after["agentpack"]).toMatchObject({
        "fixture.alpha": { pack_version: "1.1.0" },
        "fixture.beta": { pack_version: "1.0.0" },
      });
      expect(after["mcp_servers"]).toEqual(before["mcp_servers"]);
      expect(after["model"]).toEqual(before["model"]);
      expect(after["projects"]).toEqual(before["projects"]);
      for (const packId of ["fixture.alpha", "fixture.beta"]) {
        const result = await verifyInstall({ packId, projectRoot: root });
        expect(result.clean, JSON.stringify(result.drift)).toBe(true);
      }
    } finally {
      await Promise.all([root, packA, packB].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });

  it("two disjoint packs install, verify, and uninstall without touching each other", async () => {
    const { root, packA, packB } = await fixtures();
    try {
      const planA = await plan(packA, root);
      expect(planA.conflicts).toEqual([]);
      await applyInstall({ plan: planA, actor: { type: "cli" } });

      // Second pack: NO conflict on the shared config.toml.
      const planB = await plan(packB, root);
      expect(planB.conflicts.map((c) => `${c.file.path}:${c.reason}`)).toEqual([]);
      await applyInstall({ plan: planB, actor: { type: "cli" } });

      let config = readConfigSync(await readConfig(root));
      expect(config.packIds).toEqual(["fixture.alpha", "fixture.beta"]);
      expect(Object.keys(config.servers).sort()).toEqual(["alpha", "beta"]);

      // Both verify clean — installing B did not alter A's recorded fragment.
      const vA = await verifyInstall({ packId: "fixture.alpha", projectRoot: root });
      expect(vA.clean, JSON.stringify(vA.drift)).toBe(true);
      const vB = await verifyInstall({ packId: "fixture.beta", projectRoot: root });
      expect(vB.clean, JSON.stringify(vB.drift)).toBe(true);

      // Uninstalling B leaves A's metadata and server intact and still clean.
      const unB = await uninstall({ packId: "fixture.beta", projectRoot: root });
      expect(unB.conflicts).toEqual([]);
      config = readConfigSync(await readConfig(root));
      expect(config.packIds).toEqual(["fixture.alpha"]);
      expect(Object.keys(config.servers)).toEqual(["alpha"]);
      const vA2 = await verifyInstall({ packId: "fixture.alpha", projectRoot: root });
      expect(vA2.clean, JSON.stringify(vA2.drift)).toBe(true);

      // Uninstalling the last pack removes the whole metadata table; the
      // machine's own settings survive.
      await uninstall({ packId: "fixture.alpha", projectRoot: root });
      const raw = await readConfig(root);
      expect(raw["agentpack"]).toBeUndefined();
      expect(raw["mcp_servers"]).toBeUndefined();
      expect(raw["model"]).toBe("gpt-5.3-codex");
    } finally {
      await Promise.all(
        [root, packA, packB].map((d) => fs.rm(d, { recursive: true, force: true })),
      );
    }
  });

  it("emits deterministic per-pack metadata under a pack-id key", async () => {
    const { root, packA, packB } = await fixtures();
    try {
      const first = await plan(packA, root);
      const second = await plan(packA, root);
      const fragment = (p: typeof first) => p.merges.find((m) => m.path === "config.toml")!;
      expect(fragment(first).fragment).toBe(fragment(second).fragment);
      const table = parseToml(fragment(first).fragment) as Record<string, unknown>;
      const meta = (table["agentpack"] as Record<string, Record<string, unknown>>)[
        "fixture.alpha"
      ];
      expect(meta).toMatchObject({
        pack_id: "fixture.alpha",
        pack_version: "1.0.0",
        profile: "full",
        generated_by: "agentpack-cli",
      });
      // No singleton keys directly under [agentpack] — every key is a pack id.
      const topLevel = table["agentpack"] as Record<string, unknown>;
      expect(Object.keys(topLevel)).toEqual(["fixture.alpha"]);
    } finally {
      await Promise.all(
        [root, packA, packB].map((d) => fs.rm(d, { recursive: true, force: true })),
      );
    }
  });

  it("a legacy singleton [agentpack] fragment (pre-#192 manifest) still verifies and un-merges", () => {
    const legacyFragment = `[agentpack]\ngenerated_by = "agentpack-cli"\npack_id = "fixture.alpha"\npack_version = "0.9.0"\nprofile = "full"\n\n[mcp_servers.alpha]\ncommand = "alpha-mcp"\n`;
    const existing = `model = "gpt-5.3-codex"\n\n${legacyFragment}`;
    // Verify-path: the legacy fragment is intact in the legacy file.
    expect(tomlFragmentIntact(existing, legacyFragment)).toBe(true);
    // Uninstall-path: removing it leaves only the user's keys.
    const rest = parseToml(removeTomlFragment(existing, legacyFragment)!) as Record<
      string,
      unknown
    >;
    expect(rest).toEqual({ model: "gpt-5.3-codex" });
    // Update-path: the new per-pack shape replaces the legacy prior fragment
    // instead of colliding with it, and no legacy key lingers.
    const next = `[agentpack."fixture.alpha"]\ngenerated_by = "agentpack-cli"\npack_id = "fixture.alpha"\npack_version = "1.0.0"\nprofile = "full"\n\n[mcp_servers.alpha]\ncommand = "alpha-mcp"\n`;
    const merged = mergeTomlConfig(existing, next, legacyFragment);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const table = parseToml(merged.merged) as Record<string, Record<string, unknown>>;
    expect(Object.keys(table["agentpack"]!)).toEqual(["fixture.alpha"]);
    expect(table["model"]).toBe("gpt-5.3-codex");
  });
});

function readConfigSync(config: Record<string, unknown>): {
  packIds: string[];
  servers: Record<string, unknown>;
} {
  const agentpack = (config["agentpack"] ?? {}) as Record<string, unknown>;
  return {
    packIds: Object.keys(agentpack).sort(),
    servers: (config["mcp_servers"] ?? {}) as Record<string, unknown>,
  };
}
