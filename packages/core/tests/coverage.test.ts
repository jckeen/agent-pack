// Coverage-fill suite: exercises the branch paths the main four test files
// don't naturally walk. Each test here exists to close a specific gap, not
// to add semantic coverage — the meaningful tests live in manifest.test.ts,
// risk.test.ts, adapters.test.ts, and security.test.ts.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ManifestTooLargeError,
  exportPack,
  loadManifest,
  parseManifestYaml,
  resolveManifestPath,
  validateManifest,
  MAX_MANIFEST_BYTES,
} from "../src/index.js";

const TMP = path.join(os.tmpdir(), `wg-cov-${Date.now()}`);

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("parser · resolveManifestPath", () => {
  it("resolves a directory containing AGENTPACK.yaml", async () => {
    const dir = path.join(TMP, "pkg-dir");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "AGENTPACK.yaml");
    await fs.writeFile(file, "agentpack: \"1.0\"\n", "utf8");
    const resolved = await resolveManifestPath(dir);
    expect(resolved).toBe(file);
  });

  it("resolves a direct file path", async () => {
    const dir = path.join(TMP, "pkg-file");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "AGENTPACK.yaml");
    await fs.writeFile(file, "agentpack: \"1.0\"\n", "utf8");
    const resolved = await resolveManifestPath(file);
    expect(resolved).toBe(file);
  });

  it("throws when neither a file nor a directory with AGENTPACK.yaml is reachable", async () => {
    const dir = path.join(TMP, "pkg-empty");
    await fs.mkdir(dir, { recursive: true });
    await expect(resolveManifestPath(dir)).rejects.toThrow(/No `AGENTPACK\.yaml` found/);
  });

  it("throws when the path is missing entirely", async () => {
    await expect(
      resolveManifestPath(path.join(TMP, "no-such-pack")),
    ).rejects.toThrow(/Could not access/);
  });
});

describe("parser · loadManifest", () => {
  it("throws ManifestTooLargeError when file exceeds maxBytes", async () => {
    const dir = path.join(TMP, "pkg-huge");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "AGENTPACK.yaml");
    await fs.writeFile(file, "a".repeat(20), "utf8");
    await expect(loadManifest(dir, { maxBytes: 5 })).rejects.toThrow(
      ManifestTooLargeError,
    );
  });

  it("wraps YAML parse errors with the manifest path", async () => {
    const dir = path.join(TMP, "pkg-bad-yaml");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "AGENTPACK.yaml"),
      "agentpack: '1.0'\n  invalid:\n indent: bad\n",
      "utf8",
    );
    await expect(loadManifest(dir)).rejects.toThrow(/Failed to parse YAML/);
  });

  it("parseManifestYaml rejects oversized input at the byte boundary", () => {
    const yaml = "agentpack: \"1.0\"\n" + "x".repeat(MAX_MANIFEST_BYTES + 1);
    expect(() => parseManifestYaml(yaml)).toThrow(ManifestTooLargeError);
  });
});

describe("exportPack · profile resolution edge cases", () => {
  async function packWithProfiles(
    name: string,
    profiles: Record<string, { include?: string[] }>,
    exports?: { default_profile?: string },
  ): Promise<string> {
    const root = path.join(TMP, name);
    await fs.mkdir(root, { recursive: true });
    const manifest = {
      agentpack: "1.0",
      metadata: {
        id: "test.coverage",
        name: "Coverage",
        slug: "coverage",
        description: "test",
        version: "0.0.1",
        publisher: "test",
      },
      compatibility: { targets: { generic: { status: "supported" } } },
      profiles,
      atoms: [
        {
          id: "instruction:x",
          type: "instruction",
          name: "X",
          description: "y",
          path: "atoms/x.md",
          risk_level: "low",
        },
      ],
      ...(exports ? { exports } : {}),
    };
    const yamlOut = await import("yaml");
    await fs.writeFile(
      path.join(root, "AGENTPACK.yaml"),
      yamlOut.stringify(manifest),
      "utf8",
    );
    await fs.mkdir(path.join(root, "atoms"), { recursive: true });
    await fs.writeFile(path.join(root, "atoms/x.md"), "hi", "utf8");
    return root;
  }

  it("throws when --profile names an undeclared profile", async () => {
    const root = await packWithProfiles("pf-unknown", {
      safe: { include: ["instruction:x"] },
    });
    await expect(
      exportPack({
        source: root,
        target: "generic",
        profile: "nonexistent",
        outDir: path.join(TMP, "pf-unknown-out"),
      }),
    ).rejects.toThrow(/Unknown profile/);
  });

  it("uses exports.default_profile when no --profile given", async () => {
    const root = await packWithProfiles(
      "pf-default",
      { onlyone: { include: ["instruction:x"] } },
      { default_profile: "onlyone" },
    );
    const result = await exportPack({
      source: root,
      target: "generic",
      outDir: path.join(TMP, "pf-default-out"),
    });
    expect(result.plan.profile).toBe("onlyone");
  });

  it("falls through to `safe` when no profile arg and no exports.default_profile", async () => {
    const root = await packWithProfiles("pf-safe", {
      safe: { include: ["instruction:x"] },
    });
    const result = await exportPack({
      source: root,
      target: "generic",
      outDir: path.join(TMP, "pf-safe-out"),
    });
    expect(result.plan.profile).toBe("safe");
  });

  it("throws when no profile arg, no default, no safe", async () => {
    const root = await packWithProfiles("pf-none", {
      onlyone: { include: ["instruction:x"] },
    });
    await expect(
      exportPack({
        source: root,
        target: "generic",
        outDir: path.join(TMP, "pf-none-out"),
      }),
    ).rejects.toThrow(/No profile specified/);
  });

  it("validator surfaces `exports.default_profile` referencing a missing profile", () => {
    const result = validateManifest({
      agentpack: "1.0",
      metadata: {
        id: "test.default-bad",
        name: "T",
        slug: "default-bad",
        description: "t",
        version: "0.0.1",
        publisher: "test",
      },
      compatibility: { targets: { generic: { status: "supported" } } },
      profiles: { actual: { include: ["instruction:x"] } },
      atoms: [
        {
          id: "instruction:x",
          type: "instruction",
          name: "X",
          description: "y",
          path: "atoms/x.md",
          risk_level: "low",
        },
      ],
      exports: { default_profile: "missing-from-profiles" },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "exports.default_profile_unknown"),
    ).toBe(true);
  });
});

describe("adapters · cursor warning paths", () => {
  it("warns and refuses hooks, surfaces skill/command/subagent as notes", async () => {
    const root = path.join(TMP, "cursor-warnings-pack");
    await fs.mkdir(root, { recursive: true });
    const yamlPkg = await import("yaml");
    const manifest = {
      agentpack: "1.0",
      metadata: {
        id: "test.cursor-warn",
        name: "Cursor Warn",
        slug: "cursor-warn",
        description: "test",
        version: "0.0.1",
        publisher: "test",
      },
      compatibility: { targets: { cursor: { status: "supported" } } },
      permissions: {
        shell: { execution: "optional", commands: ["echo allowed"] },
      },
      profiles: { full: { include: ["*"] } },
      atoms: [
        {
          id: "instruction:i",
          type: "instruction",
          name: "I",
          description: "i",
          path: "atoms/i.md",
          risk_level: "low",
        },
        {
          id: "rule:r",
          type: "rule",
          name: "R",
          description: "r",
          path: "atoms/r.yaml",
          risk_level: "low",
        },
        {
          id: "skill:s",
          type: "skill",
          name: "S",
          description: "s",
          path: "atoms/s",
          risk_level: "low",
        },
        {
          id: "command:c",
          type: "command",
          name: "C",
          description: "c",
          path: "atoms/c.yaml",
          risk_level: "low",
        },
        {
          id: "subagent:sa",
          type: "subagent",
          name: "SA",
          description: "sa",
          path: "atoms/sa.yaml",
          risk_level: "low",
        },
        {
          id: "hook:h",
          type: "hook",
          name: "H",
          description: "h",
          path: "atoms/h.yaml",
          risk_level: "high",
        },
      ],
    };
    await fs.writeFile(
      path.join(root, "AGENTPACK.yaml"),
      yamlPkg.stringify(manifest),
      "utf8",
    );
    await fs.mkdir(path.join(root, "atoms/s"), { recursive: true });
    await fs.writeFile(path.join(root, "atoms/s/SKILL.md"), "skill body", "utf8");
    await fs.writeFile(path.join(root, "atoms/i.md"), "i body", "utf8");
    await fs.writeFile(path.join(root, "atoms/r.yaml"), "id: r\n", "utf8");
    await fs.writeFile(
      path.join(root, "atoms/c.yaml"),
      "id: c\ninvocation: { slash: '/c' }\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "atoms/sa.yaml"),
      "id: sa\ninstructions: 'do things'\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "atoms/h.yaml"),
      "id: h\nhandler: { command: 'echo allowed' }\n",
      "utf8",
    );
    const out = path.join(TMP, "cursor-warn-out");
    const result = await exportPack({
      source: root,
      target: "cursor",
      profile: "full",
      outDir: out,
      allowMissingBodies: true,
    });
    const warnings = result.plan.warnings.join("\n");
    expect(warnings).toMatch(/Hook atom .* no stable Cursor hook target/);
    expect(warnings).toMatch(/Subagent atom .* no stable Cursor subagent target/);
    expect(warnings).toMatch(/Skill atom .* Cursor has no Skills format/);
    expect(warnings).toMatch(/Command atom .* rule note/);
    expect(result.plan.unsupportedAtoms).toContain("hook:h");
  });
});

describe("adapters · generic emits hook/mcp warnings into agentpack.json", () => {
  it("includes hooks_warning and mcp_servers_warning when those atoms are present", async () => {
    const root = path.join(TMP, "generic-warn-pack");
    await fs.mkdir(root, { recursive: true });
    const yamlPkg = await import("yaml");
    const manifest = {
      agentpack: "1.0",
      metadata: {
        id: "test.generic-warn",
        name: "Generic Warn",
        slug: "generic-warn",
        description: "test",
        version: "0.0.1",
        publisher: "test",
      },
      compatibility: { targets: { generic: { status: "supported" } } },
      permissions: {
        shell: { execution: "optional", commands: ["echo ok"] },
      },
      profiles: { full: { include: ["*"] } },
      atoms: [
        {
          id: "hook:h",
          type: "hook",
          name: "H",
          description: "h",
          path: "atoms/h.yaml",
          risk_level: "high",
        },
        {
          id: "mcp_server:m",
          type: "mcp_server",
          name: "M",
          description: "m",
          path: "atoms/m.yaml",
          risk_level: "high",
        },
      ],
    };
    await fs.writeFile(
      path.join(root, "AGENTPACK.yaml"),
      yamlPkg.stringify(manifest),
      "utf8",
    );
    await fs.mkdir(path.join(root, "atoms"), { recursive: true });
    await fs.writeFile(
      path.join(root, "atoms/h.yaml"),
      "id: h\nhandler: { command: 'echo ok' }\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, "atoms/m.yaml"), "id: m\n", "utf8");
    const out = path.join(TMP, "generic-warn-out");
    await exportPack({
      source: root,
      target: "generic",
      profile: "full",
      outDir: out,
      allowMissingBodies: true,
    });
    const apJson = JSON.parse(
      await fs.readFile(path.join(out, "agentpack.json"), "utf8"),
    );
    expect(apJson.hooks_warning).toMatch(/hook atoms/);
    expect(apJson.mcp_servers_warning).toMatch(/MCP servers/);
  });
});

describe("validator · permission consistency warnings", () => {
  it("warns when hook atom present but permissions.shell missing", () => {
    const result = validateManifest({
      agentpack: "1.0",
      metadata: {
        id: "test.shell-missing",
        name: "T",
        slug: "shell-missing",
        description: "t",
        version: "0.0.1",
        publisher: "test",
      },
      compatibility: { targets: { "claude-code": { status: "supported" } } },
      profiles: { full: { include: ["hook:h"] } },
      atoms: [
        {
          id: "hook:h",
          type: "hook",
          name: "H",
          description: "h",
          path: "atoms/h.yaml",
          risk_level: "high",
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(
      result.warnings.some(
        (w) => w.code === "permission.declared_shell_missing",
      ),
    ).toBe(true);
  });

  it("warns when MCP atom with env present but permissions.secrets missing", () => {
    const result = validateManifest({
      agentpack: "1.0",
      metadata: {
        id: "test.secrets-missing",
        name: "T",
        slug: "secrets-missing",
        description: "t",
        version: "0.0.1",
        publisher: "test",
      },
      compatibility: { targets: { "claude-code": { status: "supported" } } },
      profiles: { full: { include: ["mcp_server:m"] } },
      atoms: [
        {
          id: "mcp_server:m",
          type: "mcp_server",
          name: "M",
          description: "m",
          path: "atoms/m.yaml",
          risk_level: "high",
          env: { TOKEN: { required: true } },
        },
      ],
    });
    expect(
      result.warnings.some(
        (w) => w.code === "permission.declared_secrets_missing",
      ),
    ).toBe(true);
  });

  it("warns on unknown permission category", () => {
    const result = validateManifest({
      agentpack: "1.0",
      metadata: {
        id: "test.unknown-perm",
        name: "T",
        slug: "unknown-perm",
        description: "t",
        version: "0.0.1",
        publisher: "test",
      },
      compatibility: { targets: { generic: { status: "supported" } } },
      profiles: { safe: { include: ["instruction:x"] } },
      atoms: [
        {
          id: "instruction:x",
          type: "instruction",
          name: "X",
          description: "y",
          path: "atoms/x.md",
          risk_level: "low",
          permissions: ["shell.execute"], // typo of shell.execution
        },
      ],
    });
    expect(
      result.warnings.some((w) => w.code === "atom.unknown_permission"),
    ).toBe(true);
  });
});

describe("seed · helpers", () => {
  it("getSeedPack and getSeedPackById return the same record", async () => {
    const { getSeedPack, getSeedPackById, allTags } = await import(
      "../src/seed/seedPacks.js"
    );
    const a = getSeedPack("agentpack", "pr-quality");
    const b = getSeedPackById("agentpack.pr-quality");
    expect(a).toBe(b);
    expect(allTags().length).toBeGreaterThan(0);
  });
});
