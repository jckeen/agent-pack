import { afterEach, describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { importClaudeCodeDir } from "../src/importer/importClaudeCode.js";
import { importCodexDir } from "../src/importer/importCodex.js";
import { importChatgptGptDir } from "../src/importer/importChatgptGpt.js";
import { MAX_IMPORT_TOTAL_BYTES } from "../src/importer/containedReader.js";

// Issue #216: `importClaudeCodeDir` walked skills/agents/commands with
// `fs.stat` (follows symlinks) and never checked the resolved target, so a
// cloned third-party repo imported with `--from claude-code` could pull any
// readable file into the pack. The sibling importers lacked the aggregate
// byte budget the Agent Plugins importer has.

const OPTS = { id: "acme.imported", name: "Imported" };
const SECRET = "TOP-SECRET-DO-NOT-PACKAGE";

async function tmp(): Promise<string> {
  // realpath: macOS tmpdir is itself a symlink, and containment is on real paths.
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-import-safety-")));
}

async function write(root: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

const SKILL = "---\nname: review\ndescription: Review code.\n---\n\nBody.\n";
const COMMAND = "---\ndescription: Standup.\n---\nprompt body\n";

function allContent(result: { files: Array<{ content: string }> }): string {
  return result.files.map((f) => f.content).join("\n");
}

describe("importClaudeCodeDir symlink containment", () => {
  const originalHome = process.env["HOME"];
  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  });

  it("does not read a command symlinked to a file outside the import root", async () => {
    const outside = await tmp();
    await write(outside, "id_rsa", `${SECRET}\n`);
    const root = await tmp();
    await write(root, ".claude/commands/standup.md", COMMAND);
    await fs.symlink(
      path.join(outside, "id_rsa"),
      path.join(root, ".claude/commands/leak.md"),
    );

    const result = await importClaudeCodeDir(root, OPTS);
    expect(allContent(result)).not.toContain(SECRET);
    expect(result.manifest.atoms.map((a) => a.id).join(" ")).toMatch(/standup/);
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(
      /\.claude\/commands\/leak\.md.*symlink escaping/,
    );
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("does not walk a directory symlinked out of the import root", async () => {
    const outside = await tmp();
    await write(outside, "keys/notes.md", `${SECRET}\n`);
    const root = await tmp();
    await write(root, ".claude/skills/review/SKILL.md", SKILL);
    await fs.symlink(
      path.join(outside, "keys"),
      path.join(root, ".claude/skills/review/data"),
    );

    const result = await importClaudeCodeDir(root, OPTS);
    expect(allContent(result)).not.toContain(SECRET);
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(/symlink escaping/);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("does not read through a symlinked .claude directory", async () => {
    const outside = await tmp();
    await write(outside, "commands/leak.md", `---\ndescription: x\n---\n${SECRET}\n`);
    const root = await tmp();
    await write(root, "CLAUDE.md", "# T\n\n## Style\n\nBe concise.\n");
    await fs.symlink(outside, path.join(root, ".claude"));

    const result = await importClaudeCodeDir(root, OPTS);
    expect(allContent(result)).not.toContain(SECRET);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("follows symlinks that stay inside the import root and survives a cycle", async () => {
    const root = await tmp();
    await write(root, "shared/review/SKILL.md", SKILL);
    await fs.mkdir(path.join(root, ".claude/skills"), { recursive: true });
    await fs.symlink(
      path.join(root, "shared/review"),
      path.join(root, ".claude/skills/review"),
    );
    await fs.symlink(path.join(root, "shared"), path.join(root, "shared/review/cycle"));

    const result = await importClaudeCodeDir(root, OPTS);
    expect(result.manifest.atoms.some((a) => a.type === "skill")).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("follows links out of ~/.claude into the home tree, but not beyond it", async () => {
    // The operator's own config dir is commonly symlinked into a dotfiles
    // repo elsewhere under $HOME — that is trusted; a target outside $HOME
    // is not.
    const home = await tmp();
    const outside = await tmp();
    process.env["HOME"] = home;
    await write(home, "dev/dotfiles/skills/review/SKILL.md", SKILL);
    await write(outside, "leak.md", `---\ndescription: x\n---\n${SECRET}\n`);
    await fs.mkdir(path.join(home, ".claude/commands"), { recursive: true });
    await fs.symlink(
      path.join(home, "dev/dotfiles/skills"),
      path.join(home, ".claude/skills"),
    );
    await fs.symlink(
      path.join(outside, "leak.md"),
      path.join(home, ".claude/commands/leak.md"),
    );

    const result = await importClaudeCodeDir(path.join(home, ".claude"), OPTS);
    expect(result.manifest.atoms.some((a) => a.type === "skill")).toBe(true);
    expect(allContent(result)).not.toContain(SECRET);
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("does not extend home-tree trust to a project that merely lives under $HOME", async () => {
    const home = await tmp();
    process.env["HOME"] = home;
    await write(home, ".ssh/notes.md", `---\ndescription: x\n---\n${SECRET}\n`);
    const root = path.join(home, "dev/cloned-repo");
    await write(root, ".claude/commands/standup.md", COMMAND);
    await fs.symlink(
      path.join(home, ".ssh/notes.md"),
      path.join(root, ".claude/commands/leak.md"),
    );

    const result = await importClaudeCodeDir(root, OPTS);
    expect(allContent(result)).not.toContain(SECRET);
    await fs.rm(home, { recursive: true, force: true });
  });

  it("skips a binary file with a warning instead of decoding it", async () => {
    const root = await tmp();
    await write(root, ".claude/skills/review/SKILL.md", SKILL);
    await write(
      root,
      ".claude/skills/review/logo.png",
      Buffer.from([0x89, 0x50, 0x00, 0xff]),
    );

    const result = await importClaudeCodeDir(root, OPTS);
    expect(result.files.some((f) => f.relativePath.endsWith("logo.png"))).toBe(false);
    expect(result.warnings.map((w) => w.message).join("\n")).toMatch(
      /logo\.png.*not UTF-8 text/,
    );
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe("importer aggregate byte budget", () => {
  // Each file stays under the per-file limit; together they exceed the total.
  const CHUNK = Buffer.alloc(4 * 1024 * 1024, "a");
  const COUNT = Math.floor(MAX_IMPORT_TOTAL_BYTES / CHUNK.length) + 1;

  async function fill(root: string, relDir: string): Promise<void> {
    for (let i = 0; i < COUNT; i++) await write(root, `${relDir}/part-${i}.txt`, CHUNK);
  }

  it("claude-code import refuses a source over the total budget", async () => {
    const root = await tmp();
    await write(root, ".claude/skills/big/SKILL.md", SKILL);
    await fill(root, ".claude/skills/big");
    await expect(importClaudeCodeDir(root, OPTS)).rejects.toThrow(/total budget/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("codex import refuses a source over the total budget", async () => {
    const root = await tmp();
    await write(root, ".agents/skills/big/SKILL.md", SKILL);
    await fill(root, ".agents/skills/big");
    await expect(importCodexDir(root, OPTS)).rejects.toThrow(/total budget/);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("chatgpt-gpt import refuses a bundle over the total budget", async () => {
    const root = await tmp();
    await write(root, "gpt.json", JSON.stringify({ name: "Big", instructions: "Hi." }));
    await fill(root, "knowledge");
    await expect(importChatgptGptDir(root, OPTS)).rejects.toThrow(/total budget/);
    await fs.rm(root, { recursive: true, force: true });
  });
});
