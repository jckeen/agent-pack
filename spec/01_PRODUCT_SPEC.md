# Product Spec: AgentPack + Workgraph Registry

## Product names

- Standard: **AgentPack**
- Registry/Product: **Workgraph Registry**
- CLI: **workgraph**
- Manifest: `AGENTPACK.yaml`
- Package object: AgentPack
- Package units: atoms
- Platform compilers: adapters

## Tagline

**Write once. Install anywhere agents work.**

Alternative:

**Atomic packages for AI workflows.**

## Core thesis

AI tooling is fragmenting into platform-specific customization systems. Claude Code, Codex, Cursor, ChatGPT Apps, MCP-compatible clients, GitHub Copilot, Aider, Goose, Windsurf, LangGraph, CrewAI, and other agent frameworks all expose different surfaces for instructions, tools, rules, hooks, skills, commands, plugins, subagents, workflows, and app integrations.

The future needs an atomic package format for AI behavior.

AgentPack is the missing layer above existing standards:

- MCP remains the tools/resources protocol.
- AGENTS.md remains the generic instruction target.
- Agent Skills remain the reusable capability folder format.
- Claude Code, Codex, Cursor, ChatGPT Apps, and future systems remain host platforms.
- AgentPack becomes the packaging, validation, permissions, trust, composition, install, rollback, and registry layer.

## Product separation

AgentPack + Workgraph Registry is separate from any AI social network or Workgraph context-sharing product.

Future connection points:

- Workgraph can generate AgentPacks from real user/team workflows.
- Agent Commons can let trusted users share AgentPacks.
- Workgraph Registry can publish public or private AgentPacks.
- AgentPack can include context packs exported from Workgraph.

For now, AgentPack and Workgraph Registry stand alone.

## Who it serves

### Individual builders

They want reusable coding workflows, agent skills, hooks, and project instructions without manually configuring every AI tool.

### Teams

They want shared rules, standards, workflows, review procedures, and tool connectors across Claude Code, Codex, Cursor, and other systems.

### Platform authors

They want a neutral format that can compile into their ecosystem instead of forcing every author to write bespoke adapters.

### Enterprises

They need signed packages, permission visibility, provenance, version pinning, audits, allowlists, blocklists, and admin approval.

## Primary use cases

1. Install a PR review workflow into Claude Code.
2. Export the same workflow into Codex.
3. Export team rules into Cursor.
4. Install only a single Agent Skill.
5. Install a safe profile without hooks or MCP secrets.
6. Preview what files an agent package will write.
7. Inspect package permissions before install.
8. Publish and fork reusable packs.
9. Roll back installed agent customizations.
10. Build private enterprise registries of approved agent behavior.

## Product pillars

1. **Atomicity** — every unit is independently addressable.
2. **Portability** — compile to platform-native outputs.
3. **Safety** — permission and risk transparency by default.
4. **Trust** — signatures, provenance, checksums, and review states.
5. **Composability** — packs and atoms can depend on one another.
6. **Reversibility** — install manifests and rollback plans.
7. **Adoption through compatibility** — embrace existing standards.

## MVP wedge

The MVP should prove that one AgentPack can compile to Claude Code, Codex, Cursor, and generic formats.

The first flagship example is the **Pull Request Quality Pack** because it has obvious cross-platform value and combines multiple atom types:

- instructions
- rules
- skill
- command
- subagent
- hook
- optional MCP server

## Long-term vision

Workgraph Registry becomes the marketplace, package manager, trust layer, and distribution network for AI agent behavior.

It should feel like:

- npm for agent workflows
- GitHub Marketplace for AI behavior
- Raycast Store for agent actions
- Docker Hub for portable agent capabilities
- Homebrew for agent customization

But safer, more inspectable, more permission-aware, and less tied to one vendor.
