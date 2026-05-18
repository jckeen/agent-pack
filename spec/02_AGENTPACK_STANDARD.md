# AgentPack Standard Draft

## Definition

An **AgentPack** is a portable, installable bundle of AI agent behavior. It is described by `AGENTPACK.yaml` and composed of independently installable units called **atoms**.

## Required manifest

Every pack must include:

```text
AGENTPACK.yaml
```

Recommended files:

```text
README.md
CHANGELOG.md
LICENSE
AGENTPACK.lock
signatures/checksums.json
signatures/provenance.json
```

## Recommended folder structure

```text
agentpack/
  AGENTPACK.yaml
  README.md
  CHANGELOG.md
  LICENSE
  atoms/
    instructions/
    rules/
    skills/
    hooks/
    commands/
    subagents/
    workflows/
    mcp/
    plugins/
    context/
    templates/
    evals/
  adapters/
    claude-code/
    codex/
    cursor/
    chatgpt/
    generic/
  tests/
  signatures/
```

## Atom model

An atom is the smallest installable unit of AI behavior.

Each atom must include:

- `id`
- `type`
- `name`
- `description`
- `path`
- `risk_level`
- `permissions`
- platform compatibility

Atom IDs use this pattern:

```text
<type>:<slug>
```

Examples:

```text
instruction:pr-review-standards
skill:code-review
hook:post-edit-format
mcp_server:github
```

## Required atom types

### `instruction`

Static guidance for agents.

Compiles to:

- `CLAUDE.md`
- `AGENTS.md`
- Cursor rules or instruction files
- ChatGPT project instructions
- generic instruction documents

### `rule`

Scoped behavioral rule.

Examples:

- never modify auth code without flagging security risk
- use project test commands before final answer
- require human approval before external publication

### `skill`

Reusable procedural capability.

Prefer Agent Skills-compatible folder structure:

```text
skill-name/
  SKILL.md
  scripts/
  references/
  assets/
```

### `hook`

Lifecycle automation.

Can target:

- Claude hooks
- Codex hooks
- Cursor hooks where stable
- Git hooks
- CI hooks
- generic lifecycle events

Hooks are high-risk unless proven otherwise.

### `command`

User-invoked action.

Examples:

- `/pr-summary`
- `/draft-loi`
- `/generate-social-posts`

Can compile to skills, CLI commands, platform commands, tool buttons, or prompt templates.

### `subagent`

Specialized role/persona agent.

Examples:

- security reviewer
- fact checker
- grant fit scorer
- frontend QA reviewer

### `mcp_server`

MCP server configuration.

Must declare:

- transport
- command or URL
- args
- env/secrets
- tools/resources exposed when known
- permission requirements

### `plugin`

Rich app/plugin extension.

Can target:

- ChatGPT Apps SDK
- Codex plugins
- editor extensions
- desktop app plugins

### `workflow`

Multi-step process combining atoms.

### `context_pack`

Portable user/team/project context.

Must declare sensitivity.

### `template`

Starter docs, prompts, configs, checklists, or files.

### `eval`

Behavioral tests, regression prompts, or validation scripts.

## Install profiles

Every pack should support at least:

### Safe

Allowed:

- instructions
- rules
- skills without shell/network execution
- templates
- evals that do not execute code

Disallowed:

- hooks
- MCP servers requiring secrets
- install scripts
- package installation
- shell execution

### Standard

Allowed:

- instructions
- rules
- skills
- commands
- non-dangerous configs
- subagent prompts without privileged tools

### Full

Allowed:

- hooks
- MCP servers
- subagents
- scripts
- commands
- automation

Must show warnings.

### Enterprise

Requires:

- signed package
- pinned versions
- admin approval
- policy enforcement
- auditability

## Permission categories

- `filesystem.read`
- `filesystem.write`
- `shell.execution`
- `network.access`
- `secrets.env`
- `mcp.server`
- `external_api.access`
- `browser.access`
- `repo.modification`
- `git.operations`
- `package.installation`
- `user_data.access`
- `private_context.access`
- `model_provider_key.access`

## Risk levels

- `low`
- `medium`
- `high`
- `critical`

Risk should be computed from atom risk, declared permissions, and profile selection.

## Compatibility statuses

- `supported`
- `partial`
- `experimental`
- `unsupported`

## Adapter rule

Adapters must generate platform-native outputs. AgentPack itself does not require platforms to change.

## Lockfile

`AGENTPACK.lock` should pin:

- pack ID
- pack version
- atom checksums
- dependency versions
- adapter version
- selected profile
- target platform

## Install manifest

Future install writes should create an uninstall manifest with:

- created files
- modified files
- backups
- selected atoms
- target platform
- profile
- timestamp
