import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importClaudeCodeDir, writeImport, exportPack } from "../src/index.js";
import { parse as parseYaml } from "yaml";

let tmp: string;
let cfg: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-hook-bundle-"));
  cfg = path.join(tmp, "cfg");
  await fs.mkdir(path.join(cfg, "hooks"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeSettings(hookCommand: string): Promise<void> {
  await fs.writeFile(
    path.join(cfg, "settings.json"),
    JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: hookCommand }] },
        ],
      },
    }),
  );
}

describe("hook script bundling (#90)", () => {
  it("bundles a referenced script, rewrites the command, and round-trips on install", async () => {
    const scriptPath = path.join(cfg, "hooks", "format-on-edit.sh");
    await fs.writeFile(
      scriptPath,
      "#!/usr/bin/env bash\necho BUNDLED_HOOK_SCRIPT_MARKER\n",
    );
    await writeSettings(scriptPath); // absolute path command

    const result = await importClaudeCodeDir(cfg, { id: "acme.hooks", name: "Hooks" });

    // The script body is bundled into the pack.
    const scriptFile = result.files.find((f) =>
      /^atoms\/hooks\/scripts\//.test(f.relativePath),
    );
    expect(scriptFile, "expected a bundled hook script").toBeDefined();
    expect(scriptFile!.content).toContain("BUNDLED_HOOK_SCRIPT_MARKER");

    // The hook descriptor references the bundled script + carries a rewritten command.
    const desc = result.files.find((f) =>
      /^atoms\/hooks\/[^/]+\.yaml$/.test(f.relativePath),
    );
    const parsed = parseYaml(desc!.content) as {
      handler?: { command?: string; script_path?: string };
    };
    expect(parsed.handler?.script_path).toMatch(/^atoms\/hooks\/scripts\//);
    expect(parsed.handler?.command).toContain("${CLAUDE_PROJECT_DIR}/.claude/hooks/");

    // The rewritten command is declared in permissions.shell.commands (gate).
    const cmds = result.manifest.permissions?.shell?.commands ?? [];
    expect(cmds.some((c) => c.includes("${CLAUDE_PROJECT_DIR}/.claude/hooks/"))).toBe(true);

    // Round-trip: export to claude-code writes the script + a settings.json hook.
    await writeImport(result, path.join(tmp, "pack"));
    await exportPack({
      source: path.join(tmp, "pack"),
      target: "claude-code",
      outDir: path.join(tmp, "out"),
    });
    const emittedScript = await fs.readFile(
      path.join(tmp, "out/.claude/hooks", path.basename(parsed.handler!.script_path!)),
      "utf8",
    );
    expect(emittedScript).toContain("BUNDLED_HOOK_SCRIPT_MARKER");
    const settings = JSON.parse(
      await fs.readFile(path.join(tmp, "out/.claude/settings.json"), "utf8"),
    ) as { hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    expect(settings.hooks.PostToolUse[0]!.hooks[0]!.command).toContain(
      "${CLAUDE_PROJECT_DIR}/.claude/hooks/",
    );
  });

  it("does NOT bundle a bare PATH binary — keeps the reference (no false bundling)", async () => {
    await writeSettings("prettier --write"); // a PATH binary, not a script file
    const result = await importClaudeCodeDir(cfg, { id: "acme.hooks", name: "Hooks" });
    const scriptFile = result.files.find((f) =>
      /^atoms\/hooks\/scripts\//.test(f.relativePath),
    );
    expect(scriptFile, "a bare binary must not be bundled").toBeUndefined();
    const cmds = result.manifest.permissions?.shell?.commands ?? [];
    expect(cmds).toContain("prettier --write");
  });

  function hookCommand(files: { relativePath: string; content: string }[]): string {
    const desc = files.find((f) => /^atoms\/hooks\/[^/]+\.yaml$/.test(f.relativePath));
    return (
      (parseYaml(desc!.content) as { handler?: { command?: string } }).handler?.command ??
      ""
    );
  }

  it("preserves trailing args on the rewritten command", async () => {
    const scriptPath = path.join(cfg, "hooks", "lint.sh");
    await fs.writeFile(scriptPath, "#!/usr/bin/env bash\necho hi\n");
    await writeSettings(`bash ${scriptPath} --fix --verbose`);
    const result = await importClaudeCodeDir(cfg, { id: "acme.hooks", name: "Hooks" });
    expect(hookCommand(result.files)).toContain("--fix --verbose");
  });

  it("derives the interpreter from a shebang (bun) for a bare .ts path", async () => {
    const scriptPath = path.join(cfg, "hooks", "guard.ts");
    await fs.writeFile(scriptPath, "#!/usr/bin/env bun\nconsole.log('x')\n");
    await writeSettings(scriptPath);
    const result = await importClaudeCodeDir(cfg, { id: "acme.hooks", name: "Hooks" });
    expect(hookCommand(result.files)).toMatch(/^bun \$\{CLAUDE_PROJECT_DIR\}/);
  });

  it("warns and keeps the reference when the referenced script is not found", async () => {
    const missing = path.join(cfg, "hooks", "missing.sh"); // inside the tree, but absent
    await writeSettings(missing);
    const result = await importClaudeCodeDir(cfg, { id: "acme.hooks", name: "Hooks" });
    expect(
      result.files.find((f) => /^atoms\/hooks\/scripts\//.test(f.relativePath)),
    ).toBeUndefined();
    expect(result.warnings.some((w) => /not found/i.test(w.message))).toBe(true);
    expect(result.manifest.permissions?.shell?.commands ?? []).toContain(missing);
  });

  it("does NOT bundle a script outside the import tree / ~/.claude (exfiltration guard)", async () => {
    const outside = path.join(tmp, "outside.sh"); // sibling of cfg, not inside it
    await fs.writeFile(outside, "#!/usr/bin/env bash\necho x\n");
    await writeSettings(outside);
    const result = await importClaudeCodeDir(cfg, { id: "acme.hooks", name: "Hooks" });
    expect(
      result.files.find((f) => /^atoms\/hooks\/scripts\//.test(f.relativePath)),
    ).toBeUndefined();
    expect(
      result.warnings.some((w) => /outside the imported config tree/i.test(w.message)),
    ).toBe(true);
  });

  it("does NOT follow a symlink that escapes to a non-script / out-of-tree file", async () => {
    // A .sh-named symlink INSIDE the tree pointing at a secret outside it must
    // not bundle the secret (symlink bypass of the exfiltration guard).
    const secret = path.join(tmp, "secret.txt");
    await fs.writeFile(secret, "TOTALLY_SECRET_VALUE\n");
    const link = path.join(cfg, "hooks", "evil.sh");
    await fs.symlink(secret, link);
    await writeSettings(link);
    const result = await importClaudeCodeDir(cfg, { id: "acme.hooks", name: "Hooks" });
    expect(
      result.files.find((f) => /^atoms\/hooks\/scripts\//.test(f.relativePath)),
    ).toBeUndefined();
    expect(result.files.map((f) => f.content).join("\n")).not.toContain(
      "TOTALLY_SECRET_VALUE",
    );
  });

  it("DOES follow a symlink to a script inside the tree (legit dotfiles-style)", async () => {
    const real = path.join(cfg, "scripts", "real.sh");
    await fs.mkdir(path.dirname(real), { recursive: true });
    await fs.writeFile(real, "#!/usr/bin/env bash\necho LEGIT_LINKED_SCRIPT\n");
    const link = path.join(cfg, "hooks", "linked.sh");
    await fs.symlink(real, link);
    await writeSettings(link);
    const result = await importClaudeCodeDir(cfg, { id: "acme.hooks", name: "Hooks" });
    const scriptFile = result.files.find((f) =>
      /^atoms\/hooks\/scripts\//.test(f.relativePath),
    );
    expect(scriptFile?.content).toContain("LEGIT_LINKED_SCRIPT");
  });
});
