# Adapter Spec

Adapters compile AgentPack atoms into platform-native outputs.

## General adapter responsibilities

Each adapter must:

1. Accept resolved atoms.
2. Generate target-native files.
3. Return warnings for unsupported atoms.
4. Avoid false claims about platform support.
5. Preserve BEGIN/END AgentPack markers in generated instruction files.
6. Keep output deterministic for snapshot tests.

## Claude Code adapter

Target: `claude-code`

Generate:

```text
CLAUDE.md
.claude/
  skills/
    <skill-name>/
      SKILL.md
      references/
      scripts/
      assets/
  agents/
    <subagent-name>.md
  settings.json
```

### Mapping

| Atom | Output |
|---|---|
| instruction | `CLAUDE.md` section |
| rule | `CLAUDE.md` section |
| skill | `.claude/skills/<skill>/` |
| command | skill-style command in `.claude/skills/<command>/SKILL.md` |
| subagent | `.claude/agents/<subagent>.md` |
| hook | `.claude/settings.json` hooks block |
| mcp_server | `.claude/settings.json` MCP/server block if supported; otherwise warning |
| workflow | `CLAUDE.md` workflow section |
| template | copy to target path only in future install; MVP emits README note |

### Instruction block format

```md
<!-- BEGIN AGENTPACK: agentpack.pr-quality -->
# Pull Request Quality Pack
...
<!-- END AGENTPACK: agentpack.pr-quality -->
```

## Codex adapter

Target: `codex`

Generate:

```text
AGENTS.md
.codex/
  config.toml
  hooks.json
  skills/
    <skill-name>/
      SKILL.md
  agents/
    <subagent-name>.toml
```

### Mapping

| Atom | Output |
|---|---|
| instruction | `AGENTS.md` section |
| rule | `AGENTS.md` section and optional config note |
| skill | `.codex/skills/<skill>/` |
| command | `.codex/skills/<command>/SKILL.md` or command docs section |
| subagent | `.codex/agents/<subagent>.toml` conservative proposal |
| hook | `.codex/hooks.json` |
| mcp_server | `.codex/config.toml` MCP section if supported; otherwise warning |
| workflow | `AGENTS.md` workflow section |

## Cursor adapter

Target: `cursor`

Generate:

```text
AGENTS.md
.cursor/
  rules/
    <rule-name>.mdc
  mcp.json
```

### Mapping

| Atom | Output |
|---|---|
| instruction | `AGENTS.md` and/or `.cursor/rules/*.mdc` |
| rule | `.cursor/rules/*.mdc` |
| skill | warning or generic skill export if stable target unavailable |
| command | warning or rule/prompt note |
| subagent | warning unless stable output format implemented |
| hook | warning unless stable output format implemented |
| mcp_server | `.cursor/mcp.json` |
| workflow | `AGENTS.md` workflow section |

### Cursor rule template

```md
---
description: <description>
globs:
  - "**/*"
alwaysApply: false
---

# <Rule Name>

<content>
```

## ChatGPT Apps SDK stub adapter

Target: `chatgpt`

MVP is export-only.

Generate:

```text
project-instructions.md
app-manifest.json
mcp-server/
  package.json
  src/
    index.ts
    tools/
      pr-summary.ts
    resources/
    components/
```

### Mapping

| Atom | Output |
|---|---|
| instruction | `project-instructions.md` |
| rule | `project-instructions.md` |
| command | MCP tool skeleton |
| mcp_server | referenced in app manifest / docs |
| plugin | app skeleton |
| skill | project instructions or future app docs |
| hook | unsupported warning |
| subagent | unsupported warning or instruction section |

Do not claim this installs into ChatGPT automatically.

## Generic adapter

Target: `generic`

Generate:

```text
AGENTS.md
skills/
  <skill-name>/
    SKILL.md
README-agent.md
agentpack.json
```

### Mapping

| Atom | Output |
|---|---|
| instruction | `AGENTS.md` |
| rule | `AGENTS.md` |
| skill | `skills/<skill>/` |
| command | `README-agent.md` command section |
| subagent | `README-agent.md` subagent section |
| hook | warning and `agentpack.json` metadata |
| mcp_server | warning and `agentpack.json` metadata |
| workflow | `README-agent.md` workflow section |
