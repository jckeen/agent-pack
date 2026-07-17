// #132: codex user-scope install/verify/uninstall round trip at the engine
// level, against a seeded "live" ~/.codex root. The invariant under test is
// criterion 4 of the issue: merging into the runtime's real config.toml never
// clobbers trust settings, credentials pointers, or unrelated machine
// entries — and --force deep-merges collisions (pack wins ONLY collided
// keys) instead of replacing the file.
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
} from "../src/install/index.js";

const EXAMPLE_PACK = path.resolve(__dirname, "../../../examples/pr-quality");
const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };
const PACK_ID = "agentpack.pr-quality";

const LIVE_CONFIG = `# hand-written machine config
model = "gpt-5.3-codex"
approval_policy = "on-request"

[projects."/home/me/dev/secret"]
trust_level = "trusted"

[mcp_servers.local-db]
command = "db-mcp"
`;

async function seededCodexRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-codex-root-"));
  await fs.writeFile(path.join(root, "config.toml"), LIVE_CONFIG, "utf8");
  return root;
}

async function installUserScope(root: string, force = false) {
  const plan = await planInstall({
    source: EXAMPLE_PACK,
    target: "codex",
    profile: "full" as never,
    projectRoot: root,
    scope: "user",
    generator: GEN,
  });
  const result = await applyInstall({ plan, force, actor: { type: "cli" } });
  return { plan, result };
}

describe("codex user-scope engine round trip", () => {
  it("install merges config.toml (foreign keys survive), verify is clean, user edits to OWN keys stay clean", async () => {
    const root = await seededCodexRoot();
    try {
      const { plan } = await installUserScope(root);
      expect(plan.conflicts).toEqual([]);

      const configRaw = await fs.readFile(path.join(root, "config.toml"), "utf8");
      const config = parseToml(configRaw) as Record<string, unknown>;
      expect(config["model"]).toBe("gpt-5.3-codex");
      expect(
        (config["projects"] as Record<string, Record<string, unknown>>)[
          "/home/me/dev/secret"
        ]["trust_level"],
      ).toBe("trusted");
      expect(config["agentpack"]).toBeDefined();

      let v = await verifyInstall({ packId: PACK_ID, projectRoot: root });
      expect(v.clean, JSON.stringify(v.drift)).toBe(true);

      // The user edits THEIR key — fragment-level check must stay clean.
      await fs.writeFile(
        path.join(root, "config.toml"),
        configRaw.replace('approval_policy = "on-request"', 'approval_policy = "never"'),
        "utf8",
      );
      v = await verifyInstall({ packId: PACK_ID, projectRoot: root });
      expect(v.clean, JSON.stringify(v.drift)).toBe(true);

      // Tampering with the PACK's entry is drift.
      const tampered = (await fs.readFile(path.join(root, "config.toml"), "utf8")).replace(
        /\[agentpack\]/,
        "[agentpack]\ninjected = true",
      );
      await fs.writeFile(
        path.join(root, "config.toml"),
        tampered.replace(`pack_id = "${PACK_ID}"`, 'pack_id = "evil.pack"'),
        "utf8",
      );
      v = await verifyInstall({ packId: PACK_ID, projectRoot: root });
      expect(v.clean).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uninstall surgically un-merges config.toml: pack entries gone, machine entries intact", async () => {
    const root = await seededCodexRoot();
    try {
      await installUserScope(root);
      const result = await uninstall({ packId: PACK_ID, projectRoot: root });
      expect(result.conflicts).toEqual([]);

      const configRaw = await fs.readFile(path.join(root, "config.toml"), "utf8");
      const config = parseToml(configRaw) as Record<string, unknown>;
      expect(config["agentpack"]).toBeUndefined();
      expect(config["model"]).toBe("gpt-5.3-codex");
      expect(
        (config["mcp_servers"] as Record<string, unknown> | undefined)?.["local-db"],
      ).toBeDefined();
      // Pack payload files are gone.
      await expect(fs.stat(path.join(root, "AGENTS.md"))).rejects.toThrow();
      await expect(fs.stat(path.join(root, "skills"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("a colliding key is a conflict without --force; --force deep-merges (pack wins ONLY the collided key)", async () => {
    const root = await seededCodexRoot();
    try {
      // Seed a collision: the machine already has an [agentpack] table.
      await fs.appendFile(
        path.join(root, "config.toml"),
        `\n[agentpack]\npack_id = "someone.else"\n`,
        "utf8",
      );
      const plan = await planInstall({
        source: EXAMPLE_PACK,
        target: "codex",
        profile: "full" as never,
        projectRoot: root,
        scope: "user",
        generator: GEN,
      });
      const conflict = plan.conflicts.find((c) => c.file.path === "config.toml");
      expect(conflict?.reason).toBe("toml-collision");

      // Refuses without force.
      await expect(applyInstall({ plan, actor: { type: "cli" } })).rejects.toThrow(
        /conflict/i,
      );

      // With force: collided key goes to the pack; foreign keys survive.
      await applyInstall({ plan, force: true, actor: { type: "cli" } });
      const config = parseToml(
        await fs.readFile(path.join(root, "config.toml"), "utf8"),
      ) as Record<string, unknown>;
      expect((config["agentpack"] as Record<string, unknown>)["pack_id"]).toBe(PACK_ID);
      expect(config["model"]).toBe("gpt-5.3-codex");
      expect(
        (config["projects"] as Record<string, Record<string, unknown>>)[
          "/home/me/dev/secret"
        ]["trust_level"],
      ).toBe("trusted");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
