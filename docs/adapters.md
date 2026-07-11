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
7. Emit **[Agent Skills](https://agentskills.io) spec-conformant** skill folders. The spec rules live in one module (`packages/core/src/skills/agentskills.ts`, a TS port of the reference `skills-ref` validator): emitted skill directory names are spec-normalized (lowercase/digits/hyphens, ≤64 chars), the frontmatter `name` always equals the directory name, frontmatter values are YAML-serialized (never string-interpolated), and non-spec frontmatter fields are relocated under the spec's `metadata` passthrough. An already-conformant source skill folder passes through **byte-identical**; anything auto-conformed produces a warning. The conformance gate is `packages/core/tests/agentskills-conformance.test.ts`.

## Claude Code

**Target:** `claude-code`

| Atom          | Output                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `instruction` | `CLAUDE.md` section                                                                                           |
| `rule`        | `CLAUDE.md` rules section (full body: severity, globs, must/must-not)                                         |
| `skill`       | `.claude/skills/<slug>/` (file copy of the atom dir; SKILL.md conformed to the Agent Skills spec)             |
| `command`     | `.claude/commands/<slug>.md` (real slash command — `/<slug>` works)                                           |
| `subagent`    | `.claude/agents/<slug>.md` (frontmatter: name, description, and `tools`/`model` when the source carries them) |
| `hook`        | `.claude/settings.json#hooks` block                                                                           |
| `mcp_server`  | `.mcp.json` at project root                                                                                   |
| `workflow`    | `CLAUDE.md` workflow section                                                                                  |

`CLAUDE.md` always wraps content in the AgentPack BEGIN/END markers.

Fidelity notes (these mirror what Claude Code actually reads):

- Project-scoped MCP servers live in **`.mcp.json` at the project root**, not in `.claude/settings.json` — entries written there are silently ignored by Claude Code. Schema per stdio server: `{type, command, args, env}`; env values use `${VAR}` expansion so secrets never land on disk.
- Hook entries carry **only schema keys** (`{matcher, hooks: [{type, command}]}`). Tool-event hooks default to `matcher: "Edit|Write"` (a pack can pin its own via the hook atom's `handler.matcher`); a bare `*` would fire after every tool call including reads.
- MCP servers are **gated**: the server must be declared in the manifest's `permissions.mcp.servers`, and shell-escape shapes (`bash -c`, `node -e`, …) are refused — the same posture as the hook command allow-list, so an `mcp_server` atom can't be used to smuggle arbitrary shell past it.

## Codex

**Target:** `codex`

| Atom          | Output                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `instruction` | `AGENTS.md` section                                                                                                       |
| `rule`        | `AGENTS.md` rules section (full body)                                                                                     |
| `skill`       | `.agents/skills/<slug>/` + an index entry in `AGENTS.md`                                                                  |
| `command`     | `.agents/skills/<slug>/SKILL.md` + `AGENTS.md` index entry                                                                |
| `subagent`    | `.codex/agents/<slug>.toml` with `developer_instructions`                                                                 |
| `hook`        | `.codex/hooks.json`                                                                                                       |
| `mcp_server`  | `.codex/config.toml` `[mcp_servers.<slug>]` table (same declaration + shell-escape gate as claude-code)                  |
| `workflow`    | `AGENTS.md` workflow section                                                                                              |

**Honesty note:** Codex discovers repository skills under `.agents/skills/`
and custom agents under `.codex/agents/`. The adapter also indexes skills in
`AGENTS.md` for inspection. Trusted projects load `.codex/config.toml`, and
project hooks are discovered from `.codex/hooks.json`; project-specific MCP
configuration stays scoped to that repository.

## Cursor

**Target:** `cursor`

| Atom          | Output                                                     |
| ------------- | ---------------------------------------------------------- |
| `instruction` | `AGENTS.md` section                                        |
| `rule`        | `.cursor/rules/<slug>.mdc` (frontmatter + full rule body)  |
| `skill`       | inlined into `AGENTS.md` (Cursor has no Skills format)     |
| `command`     | description surfaced in `AGENTS.md`                        |
| `subagent`    | role description surfaced in `AGENTS.md`                   |
| `hook`        | warning — no stable Cursor hook target                     |
| `mcp_server`  | `.cursor/mcp.json` entry (declaration + shell-escape gate) |
| `workflow`    | `AGENTS.md` workflow section                               |

## ChatGPT Apps SDK

**Target:** `chatgpt` (**export-only**)

| Atom          | Output                                               |
| ------------- | ---------------------------------------------------- |
| `instruction` | `project-instructions.md`                            |
| `rule`        | `project-instructions.md` rules section              |
| `command`     | `mcp-server/src/tools/<slug>.ts` stub (conservative) |
| `mcp_server`  | referenced in `app-manifest.json`                    |
| `plugin`      | `app-manifest.json` entry                            |
| `skill`       | surfaced in `project-instructions.md`                |
| `hook`        | unsupported warning                                  |
| `subagent`    | surfaced as instruction note                         |

The adapter generates a skeleton MCP app that must be reviewed and registered manually with ChatGPT. The CLI prints a clear warning.

## Generic

**Target:** `generic`

| Atom          | Output                                 |
| ------------- | -------------------------------------- |
| `instruction` | `AGENTS.md`                            |
| `rule`        | `AGENTS.md`                            |
| `skill`       | `skills/<slug>/` (Agent Skills format) |
| `command`     | `README-agent.md` command section      |
| `subagent`    | `README-agent.md` subagent section     |
| `hook`        | metadata in `agentpack.json` + warning |
| `mcp_server`  | metadata in `agentpack.json` + warning |
| `workflow`    | `README-agent.md` workflow section     |

The generic adapter is the safe target when targeting a runtime that reads `AGENTS.md` and Agent Skills without platform-specific hooks/MCP plumbing.

## Adding an adapter

1. Implement the `AgentPackAdapter` interface in `packages/core/src/adapters/<target>.ts`.
2. Use `defineAdapter()` from `adapters/types.ts` to inherit deterministic file sorting.
3. Use `wrapInstructionBlock(packId, body)` for instruction files so multiple packs can coexist.
4. Register the adapter in `packages/core/src/adapters/index.ts`.
5. Add the platform to `TargetPlatform` in `packages/core/src/schema/types.ts` (and the schema enum, and the registry's filter list).
6. Add tests in `packages/core/tests/adapters.test.ts`.
