// PR #185 codex review — three P1 data-integrity findings around forced TOML
// merges into the user-scope Codex config:
//
//   P1.1 uninstall must RESTORE a user value that a forced collision
//        overwrote (not just delete the pack's fragment);
//   P1.2 `install --force` over an unparsable config must fail closed, never
//        replace the whole file with the pack fragment;
//   P1.3 forced uninstall over an unparsable config must fail closed instead
//        of deleting the manifest/lock while the pack's config stays live.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { planInstall, applyInstall, uninstall } from "../src/install/index.js";

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

// The user's OWN github MCP entry — collides with the pack's
// `mcp_servers.github` fragment.
const USER_GITHUB = `
[mcp_servers.github]
command = "my-github-mcp"
args = ["--personal"]
`;

async function codexRoot(config: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-codex-p1-"));
  await fs.writeFile(path.join(root, "config.toml"), config, "utf8");
  return root;
}

function planUserScope(root: string) {
  return planInstall({
    source: EXAMPLE_PACK,
    target: "codex",
    profile: "full" as never,
    projectRoot: root,
    scope: "user",
    generator: GEN,
  });
}

describe("forced TOML collision + malformed-config integrity (PR #185 P1s)", () => {
  it("P1.1: uninstall restores the user's pre-install value for a forced collision key", async () => {
    const root = await codexRoot(LIVE_CONFIG + USER_GITHUB);
    try {
      const plan = await planUserScope(root);
      const conflict = plan.conflicts.find((c) => c.file.path === "config.toml");
      expect(conflict?.reason).toBe("toml-collision");
      await applyInstall({ plan, force: true, actor: { type: "cli" } });

      // Forced install: pack won the collided key.
      let config = parseToml(
        await fs.readFile(path.join(root, "config.toml"), "utf8"),
      ) as Record<string, Record<string, unknown>>;
      expect((config["mcp_servers"]["github"] as Record<string, unknown>)["command"]).toBe(
        "npx",
      );

      const result = await uninstall({ packId: PACK_ID, projectRoot: root });
      expect(result.conflicts).toEqual([]);

      config = parseToml(
        await fs.readFile(path.join(root, "config.toml"), "utf8"),
      ) as Record<string, Record<string, unknown>>;
      // The pack's contribution is gone…
      expect(config["agentpack"]).toBeUndefined();
      // …and the user's pre-install github entry is RESTORED, not deleted.
      const github = config["mcp_servers"]["github"] as Record<string, unknown>;
      expect(github).toBeDefined();
      expect(github["command"]).toBe("my-github-mcp");
      expect(github["args"]).toEqual(["--personal"]);
      // Untouched user entries survive as before.
      expect(config["mcp_servers"]["local-db"]).toBeDefined();
      expect((config as Record<string, unknown>)["model"]).toBe("gpt-5.3-codex");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("P1.2: install --force over a malformed config.toml fails closed and writes nothing", async () => {
    const broken = `model = "gpt-5.3-codex\napproval_policy = on-request\n`;
    const root = await codexRoot(broken);
    try {
      const plan = await planUserScope(root);
      const conflict = plan.conflicts.find((c) => c.file.path === "config.toml");
      expect(conflict?.reason).toBe("invalid-toml");

      await expect(
        applyInstall({ plan, force: true, actor: { type: "cli" } }),
      ).rejects.toThrow(/not valid TOML/i);

      // The malformed user file is byte-for-byte untouched — never replaced
      // by the pack fragment.
      expect(await fs.readFile(path.join(root, "config.toml"), "utf8")).toBe(broken);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("P1.3: forced uninstall over a now-unparsable config fails closed, keeping manifest + lockfile", async () => {
    const root = await codexRoot(LIVE_CONFIG);
    try {
      const plan = await planUserScope(root);
      expect(plan.conflicts).toEqual([]);
      await applyInstall({ plan, actor: { type: "cli" } });

      const goodConfig = await fs.readFile(path.join(root, "config.toml"), "utf8");
      // The config later turns unparsable (bad hand edit).
      await fs.writeFile(
        path.join(root, "config.toml"),
        `${goodConfig}\n[[broken\n`,
        "utf8",
      );

      await expect(uninstall({ packId: PACK_ID, projectRoot: root })).rejects.toThrow(
        /not valid TOML/i,
      );
      await expect(
        uninstall({ packId: PACK_ID, projectRoot: root, force: true }),
      ).rejects.toThrow(/not valid TOML/i);

      // Ownership state survives: manifest + lockfile still track the pack.
      const manifests = await fs.readdir(path.join(root, ".agentpack", "installed"));
      expect(manifests.length).toBeGreaterThan(0);
      await expect(fs.stat(path.join(root, "AGENTPACK.lock"))).resolves.toBeDefined();

      // Once the user fixes the syntax, uninstall proceeds surgically.
      await fs.writeFile(path.join(root, "config.toml"), goodConfig, "utf8");
      const result = await uninstall({ packId: PACK_ID, projectRoot: root });
      expect(result.conflicts).toEqual([]);
      const config = parseToml(
        await fs.readFile(path.join(root, "config.toml"), "utf8"),
      ) as Record<string, unknown>;
      expect(config["agentpack"]).toBeUndefined();
      expect(config["model"]).toBe("gpt-5.3-codex");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
