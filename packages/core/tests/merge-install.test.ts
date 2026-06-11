import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  planInstall,
  applyInstall,
  verifyInstall,
  uninstall,
} from "../src/install/index.js";

const EXAMPLE_PACK = path.resolve(__dirname, "../../../examples/pr-quality");
const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

async function tempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-merge-test-"));
}

async function install(
  dir: string,
  opts: { source?: string; target?: "claude-code" | "generic"; profile?: string } = {},
) {
  const plan = await planInstall({
    source: opts.source ?? EXAMPLE_PACK,
    target: opts.target ?? "claude-code",
    profile: (opts.profile ?? "safe") as never,
    projectRoot: dir,
    generator: GEN,
  });
  const result = await applyInstall({ plan, actor: { type: "cli" } });
  return { plan, result };
}

/** Copy the example pack and rewrite its id/slug so two distinct packs exist. */
async function clonePackWithId(newId: string, newSlug: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-clone-"));
  await fs.cp(EXAMPLE_PACK, dir, { recursive: true });
  const manifestPath = path.join(dir, "AGENTPACK.yaml");
  let raw = await fs.readFile(manifestPath, "utf8");
  raw = raw.replace('id: "agentpack.pr-quality"', `id: "${newId}"`);
  raw = raw.replace('slug: "pr-quality"', `slug: "${newSlug}"`);
  await fs.writeFile(manifestPath, raw, "utf8");
  return dir;
}

describe("marker-block merge: coexistence with user content", () => {
  it("appends the pack block to an existing user CLAUDE.md instead of conflicting", async () => {
    const dir = await tempProject();
    const userContent = "# My Project\n\nMy own instructions.\n";
    await fs.writeFile(path.join(dir, "CLAUDE.md"), userContent, "utf8");

    const { plan } = await install(dir);
    expect(plan.conflicts.length).toBe(0);

    const after = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(after).toContain("My own instructions.");
    expect(after).toContain("<!-- BEGIN AGENTPACK: agentpack.pr-quality -->");
    expect(after.indexOf("My own instructions.")).toBeLessThan(
      after.indexOf("<!-- BEGIN AGENTPACK"),
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("verify is clean after merge, and stays clean when the user edits THEIR sections", async () => {
    const dir = await tempProject();
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# Mine\n", "utf8");
    await install(dir);
    let v = await verifyInstall({ packId: "agentpack.pr-quality", projectRoot: dir });
    expect(v.clean).toBe(true);

    // User edits their own section — NOT drift.
    const cur = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      cur.replace("# Mine", "# Mine (renamed)"),
      "utf8",
    );
    v = await verifyInstall({ packId: "agentpack.pr-quality", projectRoot: dir });
    expect(v.clean).toBe(true);

    // User edits INSIDE our span — that IS drift.
    const cur2 = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      cur2.replace("Pull Request Quality Pack", "Tampered Pack"),
      "utf8",
    );
    v = await verifyInstall({ packId: "agentpack.pr-quality", projectRoot: dir });
    expect(v.clean).toBe(false);
    expect(v.drift.some((d) => d.path === "CLAUDE.md")).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("uninstall removes only the pack's span, preserving user content", async () => {
    const dir = await tempProject();
    const userContent = "# My Project\n\nKeep me.\n";
    await fs.writeFile(path.join(dir, "CLAUDE.md"), userContent, "utf8");
    await install(dir);

    const r = await uninstall({ packId: "agentpack.pr-quality", projectRoot: dir });
    expect(r.conflicts.length).toBe(0);

    const after = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(after).toContain("Keep me.");
    expect(after).not.toContain("AGENTPACK");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("uninstall deletes the file entirely when the pack created it and nothing else was added", async () => {
    const dir = await tempProject();
    await install(dir);
    await uninstall({ packId: "agentpack.pr-quality", projectRoot: dir });
    await expect(fs.readFile(path.join(dir, "CLAUDE.md"), "utf8")).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("uninstall preserves user content appended AFTER install to a file the pack created", async () => {
    const dir = await tempProject();
    await install(dir);
    await fs.appendFile(path.join(dir, "CLAUDE.md"), "\n# Added later by user\n", "utf8");
    await uninstall({ packId: "agentpack.pr-quality", projectRoot: dir });
    const after = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(after).toContain("Added later by user");
    expect(after).not.toContain("AGENTPACK");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("two packs coexist in one CLAUDE.md and uninstall independently", async () => {
    const dir = await tempProject();
    const otherPack = await clonePackWithId("agentpack.other-pack", "other-pack");
    await install(dir);
    await install(dir, { source: otherPack });

    const both = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(both).toContain("BEGIN AGENTPACK: agentpack.pr-quality");
    expect(both).toContain("BEGIN AGENTPACK: agentpack.other-pack");

    await uninstall({ packId: "agentpack.pr-quality", projectRoot: dir });
    const after = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    expect(after).not.toContain("BEGIN AGENTPACK: agentpack.pr-quality");
    expect(after).toContain("BEGIN AGENTPACK: agentpack.other-pack");

    const v = await verifyInstall({ packId: "agentpack.other-pack", projectRoot: dir });
    expect(v.clean).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(otherPack, { recursive: true, force: true });
  });

  it("re-install replaces the pack's span in place (no duplicate blocks)", async () => {
    const dir = await tempProject();
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# Mine\n", "utf8");
    await install(dir);
    await install(dir); // idempotent re-install
    const after = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf8");
    const count = after.split("BEGIN AGENTPACK: agentpack.pr-quality").length - 1;
    expect(count).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("JSON config merge: .claude/settings.json + .mcp.json", () => {
  it("preserves the user's existing hooks and permissions when installing the full profile", async () => {
    const dir = await tempProject();
    await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
    const userSettings = {
      permissions: { allow: ["Bash(npm test:*)"] },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] },
        ],
      },
    };
    await fs.writeFile(
      path.join(dir, ".claude/settings.json"),
      JSON.stringify(userSettings, null, 2) + "\n",
      "utf8",
    );

    const { plan } = await install(dir, { profile: "full" });
    expect(plan.conflicts.length).toBe(0);

    const after = JSON.parse(
      await fs.readFile(path.join(dir, ".claude/settings.json"), "utf8"),
    );
    // User content preserved.
    expect(after.permissions.allow).toEqual(["Bash(npm test:*)"]);
    expect(after.hooks.PreToolUse[0].hooks[0].command).toBe("echo pre");
    // Our hook added.
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe("npm run format");
    // MCP server landed in .mcp.json, not settings.json.
    expect(after.mcpServers).toBeUndefined();
    const mcp = JSON.parse(await fs.readFile(path.join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.github.command).toBe("npx");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("uninstall removes only the pack's hook entries and mcp servers", async () => {
    const dir = await tempProject();
    await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".claude/settings.json"),
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "echo user" }] },
            ],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await install(dir, { profile: "full" });
    const r = await uninstall({ packId: "agentpack.pr-quality", projectRoot: dir });
    expect(r.conflicts.length).toBe(0);

    const after = JSON.parse(
      await fs.readFile(path.join(dir, ".claude/settings.json"), "utf8"),
    );
    const entries = after.hooks.PostToolUse as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(entries.some((e) => e.hooks[0]?.command === "echo user")).toBe(true);
    expect(entries.some((e) => e.hooks[0]?.command === "npm run format")).toBe(false);
    // .mcp.json was created solely by us → removed entirely.
    await expect(fs.readFile(path.join(dir, ".mcp.json"), "utf8")).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("collides when the user already has a different mcp server under the same name", async () => {
    const dir = await tempProject();
    await fs.writeFile(
      path.join(dir, ".mcp.json"),
      JSON.stringify(
        { mcpServers: { github: { type: "stdio", command: "my-own-github-server" } } },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "claude-code",
      profile: "full" as never,
      projectRoot: dir,
      generator: GEN,
    });
    const conflict = plan.conflicts.find((c) => c.file.path === ".mcp.json");
    expect(conflict?.reason).toBe("json-collision");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("multi-target install guard (qa-lead P1-2)", () => {
  it("refuses installing the same pack for a second target into one project", async () => {
    const dir = await tempProject();
    await install(dir, { target: "claude-code" });
    await expect(install(dir, { target: "generic" })).rejects.toThrow(
      /already installed .* for target `claude-code`/,
    );
    // First target's files are untouched.
    const v = await verifyInstall({ packId: "agentpack.pr-quality", projectRoot: dir });
    expect(v.clean).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
