# Adapters

Adapters compile AgentPack atoms into platform-native outputs. The shared contract lives in [`../packages/core/src/adapters/types.ts`](../packages/core/src/adapters/types.ts); five concrete implementations ship in MVP.

## General rules

Every adapter MUST:

1. Accept resolved atoms (output of `resolveAtoms`).
2. Generate target-native files in `AdapterOutputFile[]` form.
3. Return warnings for atoms it cannot fully map; return their IDs in `unsupportedAtoms`.
4. Avoid false claims about platform support. When the platform's surface is unstable or undocumented, mark output conservatively.
5. Preserve `<!-- BEGIN AGENTPACK: <id> --> … <!-- END AGENTPACK: <id> -->` markers in generated instruction files so multiple packs can coexist.
6. Keep output **deterministic**: two consecutive exports of the same manifest + profile produce byte-identical files. Adapters sort files by path, sort JSON object keys, and emit trailing newlines consistently.

## Claude Code

**Target:** `claude-code`

| Atom           | Output                                                       |
|----------------|--------------------------------------------------------------|
| `instruction`  | `CLAUDE.md` section                                          |
| `rule`         | `CLAUDE.md` rules section                                    |
| `skill`        | `.claude/skills/<slug>/` (verbatim file copy of the atom dir)|
| `command`      | `.claude/skills/<slug>/SKILL.md` (skill-style command)       |
| `subagent`     | `.claude/agents/<slug>.md`                                   |
| `hook`         | `.claude/settings.json#hooks` block                          |
| `mcp_server`   | `.claude/settings.json#mcpServers` block                     |
| `workflow`     | `CLAUDE.md` workflow section                                 |

`CLAUDE.md` always wraps content in the AgentPack BEGIN/END markers.

## Codex

**Target:** `codex`

| Atom           | Output                                                       |
|----------------|--------------------------------------------------------------|
| `instruction`  | `AGENTS.md` section                                          |
| `rule`         | `AGENTS.md` rules section                                    |
| `skill`        | `.codex/skills/<slug>/`                                      |
| `command`      | `.codex/skills/<slug>/SKILL.md`                              |
| `subagent`     | `.codex/agents/<slug>.toml` (conservative)                   |
| `hook`         | `.codex/hooks.json` (events keyed by codex / generic mapping)|
| `mcp_server`   | `.codex/config.toml` `[mcp_servers.<slug>]` table            |
| `workflow`     | `AGENTS.md` workflow section                                 |

## Cursor

**Target:** `cursor`

| Atom           | Output                                                       |
|----------------|--------------------------------------------------------------|
| `instruction`  | `AGENTS.md` section                                          |
| `rule`         | `.cursor/rules/<slug>.mdc` (Cursor rule frontmatter)         |
| `skill`        | warning — Cursor has no native Skills format yet             |
| `command`      | rule-level note in `AGENTS.md`                               |
| `subagent`     | warning — no stable Cursor subagent target                   |
| `hook`         | warning — no stable Cursor hook target                       |
| `mcp_server`   | `.cursor/mcp.json` entry                                     |
| `workflow`     | `AGENTS.md` workflow section                                 |

## ChatGPT Apps SDK

**Target:** `chatgpt` (**export-only**)

| Atom           | Output                                                       |
|----------------|--------------------------------------------------------------|
| `instruction`  | `project-instructions.md`                                    |
| `rule`         | `project-instructions.md` rules section                      |
| `command`      | `mcp-server/src/tools/<slug>.ts` stub (conservative)         |
| `mcp_server`   | referenced in `app-manifest.json`                            |
| `plugin`       | `app-manifest.json` entry                                    |
| `skill`        | surfaced in `project-instructions.md`                        |
| `hook`         | unsupported warning                                          |
| `subagent`     | surfaced as instruction note                                 |

The adapter generates a skeleton MCP app that must be reviewed and registered manually with ChatGPT. The CLI prints a clear warning.

## Generic

**Target:** `generic`

| Atom           | Output                                                       |
|----------------|--------------------------------------------------------------|
| `instruction`  | `AGENTS.md`                                                  |
| `rule`         | `AGENTS.md`                                                  |
| `skill`        | `skills/<slug>/` (Agent Skills format)                       |
| `command`      | `README-agent.md` command section                            |
| `subagent`     | `README-agent.md` subagent section                           |
| `hook`         | metadata in `agentpack.json` + warning                       |
| `mcp_server`   | metadata in `agentpack.json` + warning                       |
| `workflow`     | `README-agent.md` workflow section                           |

The generic adapter is the safe target when targeting a runtime that reads `AGENTS.md` and Agent Skills without platform-specific hooks/MCP plumbing.

## Adding an adapter

1. Implement the `AgentPackAdapter` interface in `packages/core/src/adapters/<target>.ts`.
2. Use `defineAdapter()` from `adapters/types.ts` to inherit deterministic file sorting.
3. Use `wrapInstructionBlock(packId, body)` for instruction files so multiple packs can coexist.
4. Register the adapter in `packages/core/src/adapters/index.ts`.
5. Add the platform to `TargetPlatform` in `packages/core/src/schema/types.ts` (and the schema enum, and the registry's filter list).
6. Add tests in `packages/core/tests/adapters.test.ts`.
