// #132: user-scope path mapping for Codex and generic (Antigravity) targets.
// The mapping tables are load-bearing: the codex importer reads the SAME
// home-style layout back (`~/.codex`: AGENTS.md, config.toml, hooks.json,
// skills/, agents/*.toml), and Antigravity's global discovery reads AGENTS.md
// + skills/ directly in `~/.gemini/config` (verified against agy 1.1.3).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { planInstall } from "../src/install/index.js";
import {
  USER_SCOPE_TARGETS,
  userScopeRoot,
  allUserScopeRoots,
  mapOutputToUserScope,
} from "../src/install/userScope.js";
import { mapCodexOutputToUserScope } from "../src/adapters/codex.js";
import { mapGenericOutputToUserScope } from "../src/adapters/generic.js";

const EXAMPLE_PACK = path.resolve(__dirname, "../../../examples/pr-quality");
const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

describe("userScopeRoot", () => {
  it("maps each supported target to its documented user root", () => {
    const home = os.homedir();
    expect(userScopeRoot("claude-code")).toBe(path.join(home, ".claude"));
    expect(userScopeRoot("codex")).toBe(path.join(home, ".codex"));
    expect(userScopeRoot("generic")).toBe(path.join(home, ".gemini", "config"));
  });

  it("returns null for targets without a user-scope mapping", () => {
    expect(userScopeRoot("cursor")).toBeNull();
    expect(userScopeRoot("chatgpt")).toBeNull();
  });

  it("USER_SCOPE_TARGETS and allUserScopeRoots agree", () => {
    expect(USER_SCOPE_TARGETS.sort()).toEqual(["claude-code", "codex", "generic"]);
    expect(allUserScopeRoots().length).toBe(3);
    for (const t of USER_SCOPE_TARGETS) {
      expect(allUserScopeRoots()).toContain(userScopeRoot(t)!);
    }
  });
});

describe("mapCodexOutputToUserScope", () => {
  it("maps every codex project-layout path to its ~/.codex user-layout twin", () => {
    const table: Array<[string, string]> = [
      ["AGENTS.md", "AGENTS.md"],
      [".codex/config.toml", "config.toml"],
      [".codex/hooks.json", "hooks.json"],
      [".codex/agents/reviewer.toml", "agents/reviewer.toml"],
      [".agents/skills/code-review/SKILL.md", "skills/code-review/SKILL.md"],
      [".agents/skills/code-review/reference.md", "skills/code-review/reference.md"],
    ];
    for (const [from, to] of table) {
      expect(mapCodexOutputToUserScope({ path: from, content: "x" }).path).toBe(to);
    }
  });

  it("rewrites AGENTS.md skill-index references to the mapped skills/ location", () => {
    const mapped = mapCodexOutputToUserScope({
      path: "AGENTS.md",
      content: "- **Review** (`.agents/skills/code-review/SKILL.md`) — desc",
    });
    expect(mapped.content).toContain("`skills/code-review/SKILL.md`");
    expect(mapped.content).not.toContain(".agents/skills/");
  });
});

describe("mapGenericOutputToUserScope", () => {
  it("is the identity mapping — Antigravity reads the generic layout as-is", () => {
    for (const p of ["AGENTS.md", "skills/code-review/SKILL.md", "agentpack.json"]) {
      const mapped = mapGenericOutputToUserScope({ path: p, content: "c" });
      expect(mapped).toEqual({ path: p, content: "c" });
    }
  });
});

describe("mapOutputToUserScope dispatch", () => {
  it("throws for targets without a user-scope mapping", () => {
    expect(() => mapOutputToUserScope("cursor", { path: "x", content: "y" })).toThrow(
      /scope user/i,
    );
  });
});

describe("planInstall --scope user (codex)", () => {
  it("stages user-layout paths only, and records a toml merge for config.toml", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-codex-user-"));
    try {
      const plan = await planInstall({
        source: EXAMPLE_PACK,
        target: "codex",
        profile: "full" as never,
        projectRoot: root,
        scope: "user",
        generator: GEN,
      });
      const paths = [
        ...plan.created.map((f) => f.path),
        ...plan.modified.map((f) => f.path),
      ];
      // No project-layout prefixes survive the remap.
      for (const p of paths) {
        expect(p.startsWith(".codex/")).toBe(false);
        expect(p.startsWith(".agents/")).toBe(false);
      }
      expect(paths).toContain("AGENTS.md");
      expect(paths).toContain("config.toml");
      expect(paths.some((p) => p.startsWith("skills/"))).toBe(true);
      const configMerge = plan.merges.find((m) => m.path === "config.toml");
      expect(configMerge?.strategy).toBe("toml");
      expect(plan.scope).toBe("user");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("deep-merges into an existing config.toml preserving foreign keys (plan-level)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-codex-merge-"));
    try {
      await fs.writeFile(
        path.join(root, "config.toml"),
        `model = "gpt-5.3-codex"\n\n[projects."/home/me/x"]\ntrust_level = "trusted"\n`,
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
      expect(plan.conflicts.map((c) => c.file.path)).not.toContain("config.toml");
      const staged = [...plan.created, ...plan.modified].find(
        (f) => f.path === "config.toml",
      );
      expect(staged).toBeDefined();
      expect(staged!.content).toContain('model = "gpt-5.3-codex"');
      expect(staged!.content).toContain('trust_level = "trusted"');
      expect(staged!.content).toContain("[agentpack]");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("planInstall --scope user (generic)", () => {
  it("stages the generic layout unchanged (AGENTS.md + skills/)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-generic-user-"));
    try {
      const plan = await planInstall({
        source: EXAMPLE_PACK,
        target: "generic",
        profile: "safe" as never,
        projectRoot: root,
        scope: "user",
        generator: GEN,
      });
      const paths = plan.created.map((f) => f.path);
      expect(paths).toContain("AGENTS.md");
      expect(paths.some((p) => p.startsWith("skills/"))).toBe(true);
      expect(plan.scope).toBe("user");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("planInstall --scope user (unsupported target)", () => {
  it("refuses cursor at user scope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-cursor-user-"));
    try {
      await expect(
        planInstall({
          source: EXAMPLE_PACK,
          target: "cursor",
          profile: "safe" as never,
          projectRoot: root,
          scope: "user",
          generator: GEN,
        }),
      ).rejects.toThrow(/scope user/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
