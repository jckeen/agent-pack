import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";

const STARTER_TEMPLATE = `agentpack: "1.0"

metadata:
  id: "your-publisher.your-pack"
  name: "Your Pack"
  slug: "your-pack"
  description: "What this AgentPack does."
  version: "0.1.0"
  license: "MIT"
  publisher: "your-publisher"
  authors:
    - name: "Your Name"
      email: "you@example.com"
  tags:
    - example

compatibility:
  targets:
    claude-code:
      status: supported
    codex:
      status: supported
    cursor:
      status: partial
    chatgpt:
      status: experimental
    generic:
      status: supported

permissions:
  filesystem:
    read:
      - "."

profiles:
  safe:
    description: "Instructions and rules only. No hooks, MCP, or secrets."
    include:
      - "instruction:project-defaults"
  standard:
    description: "Adds the skill."
    include:
      - "instruction:project-defaults"
      - "skill:example-skill"

atoms:
  - id: "instruction:project-defaults"
    type: instruction
    name: "Project Defaults"
    description: "Default project guidance for agents."
    path: "atoms/instructions/project-defaults.md"
    risk_level: low

  - id: "skill:example-skill"
    type: skill
    name: "Example Skill"
    description: "Replace with your skill content."
    path: "atoms/skills/example-skill"
    skill_format: "agentskills"
    risk_level: low

exports:
  default_profile: safe
  output_dir: dist
`;

const STARTER_INSTRUCTION = `# Project Defaults

Replace this file with the standing instructions you want agents to follow on every task in this repo.
`;

const STARTER_SKILL_MD = `---
name: example-skill
description: Replace this with what your skill does.
---

# Example Skill

Use this skill when the user asks for an example.
`;

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Scaffold a starter AGENTPACK.yaml in the current directory.")
    .option("-f, --force", "overwrite existing files", false)
    .action(async (options: { force: boolean }) => {
      const cwd = process.cwd();
      const manifestPath = path.join(cwd, "AGENTPACK.yaml");
      const instructionPath = path.join(
        cwd,
        "atoms/instructions/project-defaults.md",
      );
      const skillPath = path.join(cwd, "atoms/skills/example-skill/SKILL.md");

      const writeOnce = async (target: string, body: string) => {
        try {
          await fs.access(target);
          if (!options.force) {
            console.log(pc.yellow(`! ${target} exists — skipping (use --force to overwrite).`));
            return;
          }
        } catch {
          // does not exist; fall through.
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, body, "utf8");
        console.log(pc.green(`✓ wrote ${path.relative(cwd, target)}`));
      };

      await writeOnce(manifestPath, STARTER_TEMPLATE);
      await writeOnce(instructionPath, STARTER_INSTRUCTION);
      await writeOnce(skillPath, STARTER_SKILL_MD);
      console.log(pc.bold("\nNext: edit AGENTPACK.yaml, then run `agentpack validate`."));
    });
}
