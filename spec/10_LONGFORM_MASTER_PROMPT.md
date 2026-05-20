# MASTER PROMPT: Build AgentPack + AgentPack Registry

You are an elite AI infrastructure architect, prompt engineer, protocol designer, product strategist, software supply chain security engineer, and full-stack TypeScript systems engineer.

We are starting a new project from scratch.

The project is **AgentPack**, an open, atomic packaging standard for AI workflows, skills, hooks, plugins, rules, MCP tools, subagents, commands, context packs, templates, evals, and platform-specific agent customizations.

The product built around it is **AgentPack Registry**, a cross-platform registry, browser, validator, installer, and export system for AgentPacks.

The CLI is called `workgraph`.

The package manifest is `AGENTPACK.yaml`.

The package units are called **atoms**.

Platform compilers are called **adapters**.

## Core thesis

The future needs an atomic package format for AI behavior.

Users should be able to install one workflow, one skill, one hook, one MCP connector, one set of rules, one subagent, or an entire bundle across Claude Code, Codex, Cursor, ChatGPT, and future agent platforms.

AgentPack should feel like:

- npm for agent workflows
- GitHub Marketplace for AI behavior
- Raycast Store for agent actions
- Docker Hub for portable agent capabilities
- Homebrew for agent customization

But safer, more transparent, more atomic, and cross-platform.

## Critical design principle

Do not attempt to replace existing standards.

AgentPack compiles to and interoperates with them.

Treat:

- MCP as the tools/resources protocol.
- AGENTS.md as the generic project instruction target.
- CLAUDE.md as a Claude-specific instruction target.
- Agent Skills as a portable skill atom format.
- Cursor rules as a platform-specific rule target.
- Claude/Cursor/Codex hooks as lifecycle automation targets.
- ChatGPT Apps as MCP-backed app/plugin targets.
- Platform configs as adapter outputs.

AgentPack is the packaging, validation, distribution, permissions, composition, and installation layer above these.

## Build objective

Build the full local-first MVP and architecture for the future full product.

Do not merely write a concept doc. Create a working monorepo with:

- shared schema
- parser
- validator
- risk engine
- permission summary
- install planner
- adapter exporters
- CLI
- Next.js registry web app
- seed packs
- example Pull Request Quality Pack
- tests
- docs

## Required atom types

1. `instruction`
2. `rule`
3. `skill`
4. `hook`
5. `command`
6. `subagent`
7. `mcp_server`
8. `plugin`
9. `workflow`
10. `context_pack`
11. `template`
12. `eval`

## Required profiles

- safe
- standard
- full
- enterprise

## Required permissions

- filesystem read
- filesystem write
- shell execution
- network access
- secrets/env vars
- MCP server access
- external API access
- browser access
- repo modification
- git operations
- package installation
- user data access
- private context access
- model/provider key access

## Required targets

- Claude Code
- Codex
- Cursor
- ChatGPT stub
- Generic

## Tech stack

Use:

- pnpm workspace
- TypeScript
- Next.js App Router
- Tailwind CSS
- zod
- yaml
- commander
- picocolors
- ora
- diff
- vitest

## CLI commands

Implement:

```bash
agentpack init
agentpack validate [path]
agentpack inspect [path]
agentpack plan [path] --target claude-code --profile safe
agentpack pack export [path] --target claude-code --out dist/claude
agentpack pack export [path] --target codex --out dist/codex
agentpack pack export [path] --target cursor --out dist/cursor
agentpack pack export [path] --target chatgpt --out dist/chatgpt
agentpack pack export [path] --target generic --out dist/generic
agentpack doctor
```

## Web app routes

Build:

- `/`
- `/packs`
- `/packs/[publisher]/[slug]`
- `/validate`
- `/docs`

## Adapter outputs

Claude Code:

```text
CLAUDE.md
.claude/skills/
.claude/settings.json
.claude/agents/
```

Codex:

```text
AGENTS.md
.codex/config.toml
.codex/hooks.json
.codex/skills/
.codex/agents/
```

Cursor:

```text
AGENTS.md
.cursor/rules/
.cursor/mcp.json
```

ChatGPT stub:

```text
project-instructions.md
app-manifest.json
mcp-server/package.json
mcp-server/src/index.ts
mcp-server/src/tools/
```

Generic:

```text
AGENTS.md
skills/
README-agent.md
agentpack.json
```

## Seed packs

Include:

1. Pull Request Quality Pack
2. Claude Code Starter Pack
3. Codex AGENTS.md Starter Pack
4. Cursor Rules Starter Pack
5. Newsroom Editorial Workflow Pack
6. Grant Research Workflow Pack
7. HR-Sensitive Communications Pack
8. Frontend QA Pack
9. Conference Follow-Up Pack
10. MCP GitHub Connector Pack

## Acceptance criteria

The build is complete when:

- `pnpm install` works
- `pnpm build` works
- `pnpm test` works
- `pnpm dev` starts the web app
- `agentpack validate examples/pr-quality` passes
- `agentpack plan examples/pr-quality --target claude-code --profile safe` shows low-risk plan
- `agentpack plan examples/pr-quality --target claude-code --profile full` warns about shell/hooks/MCP/secrets
- export commands generate expected target files
- web UI renders seed packs and detail pages
- validate page validates YAML
- docs and README are clear

Build it now.
