import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPack } from "../src/index.js";

const tmpRoot = path.join(os.tmpdir(), `agentpack-subagent-body-${Date.now()}`);

const MANIFEST = JSON.stringify({
  agentpack: "1.0",
  metadata: {
    id: "acme.subagents",
    name: "Subagents",
    slug: "subagents",
    description: "subagent body test",
    version: "0.1.0",
    license: "MIT",
    publisher: "acme",
  },
  compatibility: { targets: { "claude-code": { status: "supported" } } },
  permissions: {},
  security: { risk_level: "low" },
  profiles: { all: { description: "all", include: ["*"] } },
  atoms: [
    // Markdown body (Claude Code native format): frontmatter + system prompt.
    {
      id: "subagent:md-agent",
      type: "subagent",
      name: "md-agent",
      description: "Short one-line description.",
      path: "agents/md-agent.md",
      risk_level: "medium",
      permissions: [],
    },
    // YAML-descriptor body (importer-emitted): must still work (back-compat).
    {
      id: "subagent:yaml-agent",
      type: "subagent",
      name: "yaml-agent",
      description: "Yaml agent description.",
      path: "agents/yaml-agent.yaml",
      risk_level: "medium",
      permissions: [],
    },
  ],
  exports: { default_profile: "all" },
});

const MD_AGENT = `---
name: md-agent
description: Description from the agent frontmatter.
tools: Read, Grep
model: sonnet
---

UNIQUE_MD_BODY_MARKER — you are a specialist. Follow these multi-line
instructions carefully and do not collapse to a one-liner.
`;

const YAML_AGENT = `id: yaml-agent
name: yaml-agent
instructions: UNIQUE_YAML_BODY_MARKER multi-line descriptor instructions.
`;

beforeAll(async () => {
  const pack = path.join(tmpRoot, "pack");
  await fs.mkdir(path.join(pack, "agents"), { recursive: true });
  await fs.writeFile(path.join(pack, "AGENTPACK.yaml"), MANIFEST);
  await fs.writeFile(path.join(pack, "agents/md-agent.md"), MD_AGENT);
  await fs.writeFile(path.join(pack, "agents/yaml-agent.yaml"), YAML_AGENT);
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("subagent atom body resolution", () => {
  it("carries a markdown body (frontmatter + prompt) into the emitted agent", async () => {
    const outDir = path.join(tmpRoot, "out");
    await exportPack({ source: path.join(tmpRoot, "pack"), target: "claude-code", outDir });
    const emitted = await fs.readFile(
      path.join(outDir, ".claude/agents/md-agent.md"),
      "utf8",
    );
    // The real system prompt survives — not just the one-line description.
    expect(emitted).toContain("UNIQUE_MD_BODY_MARKER");
    // Frontmatter `description` is preferred over the terse atom description.
    expect(emitted).toContain("Description from the agent frontmatter.");
    // `tools` and `model` frontmatter survive into the emitted agent (#91 follow-up).
    expect(emitted).toMatch(/^tools:\s*Read, Grep\s*$/m);
    expect(emitted).toMatch(/^model:\s*sonnet\s*$/m);
  });

  it("still resolves a YAML-descriptor body via the `instructions` field (back-compat)", async () => {
    const outDir = path.join(tmpRoot, "out");
    await exportPack({ source: path.join(tmpRoot, "pack"), target: "claude-code", outDir });
    const emitted = await fs.readFile(
      path.join(outDir, ".claude/agents/yaml-agent.md"),
      "utf8",
    );
    expect(emitted).toContain("UNIQUE_YAML_BODY_MARKER");
  });

  it("emits a markdown-sourced body verbatim — no synthesized heading (#102)", async () => {
    const outDir = path.join(tmpRoot, "out-verbatim");
    await exportPack({ source: path.join(tmpRoot, "pack"), target: "claude-code", outDir });
    const emitted = await fs.readFile(
      path.join(outDir, ".claude/agents/md-agent.md"),
      "utf8",
    );
    expect(emitted).not.toContain("# md-agent");
    // The body after the frontmatter is exactly the source prompt.
    const body = emitted.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    const sourceBody = MD_AGENT.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    expect(body).toBe(sourceBody);
  });

  it("keeps the synthesized heading for descriptor-sourced bodies", async () => {
    const outDir = path.join(tmpRoot, "out-verbatim");
    await exportPack({ source: path.join(tmpRoot, "pack"), target: "claude-code", outDir });
    const emitted = await fs.readFile(
      path.join(outDir, ".claude/agents/yaml-agent.md"),
      "utf8",
    );
    // A YAML descriptor has no markdown body of its own; the heading gives the
    // emitted agent a title and stays for back-compat.
    expect(emitted).toContain("# yaml-agent");
  });
});
