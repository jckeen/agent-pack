/**
 * Doc-truth guard for the website's hand-maintained copy (issue: docs drift).
 *
 * The registry's landing and docs pages are JSX, so `scripts/check-doc-truth.sh`
 * (which only globs *.md) cannot see them — this test is their CI guard. It
 * asserts the copy names every shipped CLI command and stays free of known-stale
 * claims that have already burned us once:
 *   - "npx agentpack ..." (the CLI is not on npm yet)
 *   - "never writes outside the --out" as a blanket CLI claim (false since
 *     Phase 2: install/uninstall/rollback write into the project root)
 *
 * When a CLI command is added or renamed, packages/cli/src/commands/ changes —
 * update the docs page AND this list in the same PR.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const APP_DIR = path.resolve(__dirname, "../app");
const landing = fs.readFileSync(path.join(APP_DIR, "page.tsx"), "utf8");
const docs = fs.readFileSync(path.join(APP_DIR, "docs/page.tsx"), "utf8");

// Every user-facing CLI command (one .ts per command in packages/cli/src/commands).
const CLI_COMMANDS = [
  "init",
  "import",
  "validate",
  "inspect",
  "plan",
  "pack",
  "doctor",
  "install",
  "uninstall",
  "diff",
  "history",
  "rollback",
  "verify",
  "update",
  "login",
  "whoami",
  "tokens",
  "publish",
  "cache",
];

describe("website copy stays in sync with the shipped CLI", () => {
  it("docs page names every CLI command", () => {
    for (const cmd of CLI_COMMANDS) {
      expect(docs, `docs page is missing CLI command \`${cmd}\``).toContain(cmd);
    }
  });

  it("docs page covers the pack subcommands and git-source install", () => {
    for (const token of [
      "plugin",
      "mcpb",
      "chat",
      "github:owner/repo@ref",
      "--allow-exec",
    ]) {
      expect(docs, `docs page is missing \`${token}\``).toContain(token);
    }
  });

  it("landing quickstart uses commands that work today", () => {
    // Git-source install is the working no-registry path and must stay first-class.
    expect(landing).toContain("github:");
    // The CLI is not published to npm; `npx agentpack` does not resolve.
    expect(landing).not.toContain("npx agentpack");
    expect(docs).not.toContain("npx agentpack");
  });

  it("stale blanket security claim stays dead", () => {
    expect(docs).not.toContain("The CLI never writes outside");
  });

  it("command list in this guard matches packages/cli/src/commands/", () => {
    const commandsDir = path.resolve(__dirname, "../../../packages/cli/src/commands");
    const shipped = fs
      .readdirSync(commandsDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    expect([...CLI_COMMANDS].sort()).toEqual(shipped);
  });
});
