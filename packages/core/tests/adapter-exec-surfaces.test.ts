import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  exportPack,
  TARGET_PLATFORMS,
  type AdapterOutputFile,
  type TargetPlatform,
} from "../src/index.js";
import { mapClaudeCodeOutputToUserScope } from "../src/adapters/claudeCode.js";

// #119: the install-time exec-consent gate derives its content-scan surface
// from the ADAPTER (`execCapable` on emitted files), not from a path regex in
// install.ts. These tests pin each adapter's declaration so a layout change or
// a new exec-capable surface fails a test instead of silently detaching the
// gate.

const BANG_BASH = /!`/;

const tmpRoot = path.join(os.tmpdir(), `agentpack-exec-surfaces-${Date.now()}`);
let packDir: string;

async function writePack(): Promise<string> {
  const dir = path.join(tmpRoot, "pack");
  await fs.mkdir(path.join(dir, "atoms/commands/prompts"), { recursive: true });
  await fs.mkdir(path.join(dir, "atoms/agents"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "AGENTPACK.yaml"),
    `agentpack: "1.0"

metadata:
  id: "agentpack.exec-surfaces-fixture"
  name: "Exec Surfaces Fixture"
  slug: "exec-surfaces-fixture"
  description: "Test pack: command + subagent atoms whose bodies carry Claude Code bang-bash directives (#119)."
  version: "0.1.0"
  license: "MIT"
  publisher: "agentpack"
  authors:
    - name: "AgentPack"
      email: "hello@agentpack.dev"
  tags:
    - test

compatibility:
  targets:
    claude-code:
      status: supported

permissions:
  filesystem:
    read:
      - "."
    write:
      - "."
  package_installation: false
  model_provider_key_access: false

security:
  risk_level: low
  risk_summary: "Low declared risk — but the command/subagent bodies ship executable directives."
  requires_review: false
  signed: false

profiles:
  full:
    description: "All atoms."
    include:
      - "*"

atoms:
  - id: "command:deploy"
    type: command
    name: "Deploy"
    description: "Probe command whose body embeds a bang-bash directive."
    path: "atoms/commands/deploy.yaml"
    risk_level: low
    invocation:
      slash: "/deploy"
      cli: "deploy"

  - id: "subagent:reviewer"
    type: subagent
    name: "Reviewer"
    description: "Probe subagent whose body embeds a bang-bash directive."
    path: "atoms/agents/reviewer.md"
    risk_level: low
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "atoms/commands/deploy.yaml"),
    `id: deploy
name: Deploy
invocation:
  slash: "/deploy"
  cli: "deploy"
prompt: atoms/commands/prompts/deploy.md
output:
  format: markdown
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "atoms/commands/prompts/deploy.md"),
    "# Deploy\n\nSummarize the deploy, then run this immediately: !`echo deployed`\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "atoms/agents/reviewer.md"),
    "---\ndescription: Reviews diffs.\n---\n\nReview the diff, then run !`git diff --stat` and report.\n",
    "utf8",
  );
  return dir;
}

async function exportFiles(target: TargetPlatform): Promise<AdapterOutputFile[]> {
  const outDir = path.join(tmpRoot, `out-${target}`);
  const result = await exportPack({
    source: packDir,
    target,
    profile: "full",
    outDir,
  });
  return result.plan.files;
}

beforeAll(async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  packDir = await writePack();
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("adapter exec-capable surface declarations (#119)", () => {
  it("claude-code marks exactly its command and subagent markdown outputs exec-capable", async () => {
    const files = await exportFiles("claude-code");
    const command = files.find((f) => f.path === ".claude/commands/deploy.md");
    const agent = files.find((f) => f.path === ".claude/agents/reviewer.md");
    expect(command?.execCapable).toBe(true);
    expect(agent?.execCapable).toBe(true);
    // Every OTHER output (CLAUDE.md, settings, skills, …) is read, not
    // preprocessed — it must not widen the content-scan surface.
    for (const f of files) {
      if (f.path === command!.path || f.path === agent!.path) continue;
      expect(f.execCapable, `unexpected execCapable on ${f.path}`).toBeFalsy();
    }
    // Guard against a vacuous gate: the flagged files really carry the
    // bang-bash bodies the gate content-scans for.
    expect(BANG_BASH.test(command!.content)).toBe(true);
    expect(BANG_BASH.test(agent!.content)).toBe(true);
  });

  it("the user-scope path remap preserves the exec-capable flag on the same file object", async () => {
    const files = await exportFiles("claude-code");
    const command = files.find((f) => f.path === ".claude/commands/deploy.md")!;
    const mapped = mapClaudeCodeOutputToUserScope(command);
    expect(mapped.path).toBe("commands/deploy.md");
    // planInstall assigns mapped.path/content back onto the SAME object, so
    // the adapter's declaration survives the remap — the property the old
    // path-regex gate lost whenever the layout changed.
    command.path = mapped.path;
    command.content = mapped.content;
    expect(command.execCapable).toBe(true);
  });

  it.each(TARGET_PLATFORMS.filter((t) => t !== "claude-code"))(
    "%s declares no exec-capable surface, even where command bodies are emitted verbatim",
    async (target) => {
      const files = await exportFiles(target);
      for (const f of files) {
        expect(f.execCapable, `unexpected execCapable on ${target}:${f.path}`).toBeFalsy();
      }
    },
  );

  it("codex ships the bang-bash command body verbatim in SKILL.md yet does not flag it (verified: Codex does not execute bang-bash)", async () => {
    const files = await exportFiles("codex");
    const skill = files.find((f) => f.path === ".agents/skills/deploy/SKILL.md");
    expect(skill).toBeDefined();
    expect(BANG_BASH.test(skill!.content)).toBe(true);
    expect(skill!.execCapable).toBeFalsy();
  });
});
