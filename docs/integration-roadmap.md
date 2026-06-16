# Cross-surface integration roadmap

How AgentPack reaches the Claude (and adjacent OpenAI) surfaces, and where the
defensible value is. Synthesized from a June 2026 live-docs research sweep across
Claude Code (cloud + mobile), Claude CoWork, Claude Chat (claude.ai), and the
OpenAI ecosystem (GPTs, Apps SDK, Codex).

Open work is tracked in GitHub issues (linked below) — this doc holds the durable
strategy, not task state.

## The thesis

AgentPack's **compiler already reaches the whole ecosystem.** Across every surface
the same pattern holds: the install model is **ungoverned, one-at-a-time, and
non-ambient.** The compile layer is platform-absorbable; the durable value — the
moat — is the **bundle + policy + version/governance layer** over those models
(signed manifest, version pinning, per-atom portability/risk report, org
distribution). See [[agentpack-positioning-governance-is-the-moat]].

Two load-bearing facts:

1. **MCP is the universal spine.** Codex, the OpenAI Apps SDK, and Claude
   Connectors are all MCP. A remote `mcp_server` atom compiles directly to a
   Claude Connector and is reusable by an Apps SDK server — build the
   OpenAPI-Action→MCP transpiler once and cover GPT Actions + Apps + Codex tools.
2. **The hard part is acquisition, not format.** OpenAI offers no GPT config
   export, so consumer-GPT import is fundamentally human-seeded. Codex, by
   contrast, is a near-lossless clean lane (shared SKILL.md / MCP / hooks /
   subagents / AGENTS.md).

## Surface reach

| Surface                                  | Reach today                                          | Compile target                                       | Net-new work                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Claude Code — terminal / IDE**         | Full (highest fidelity)                              | `.claude/` + `.mcp.json` + hooks                     | —                                                                                                               |
| **Claude Code — cloud (claude.ai/code)** | Works: clones repo `.claude/`; account-level plugins | repo-committed `.claude/` + plugin                   | docs only                                                                                                       |
| **Claude Code — mobile**                 | Control surface only (no independent execution)      | n/a (steers a local/cloud session)                   | docs only                                                                                                       |
| **CoWork**                               | Works via existing `plugin` target                   | Claude Code plugin (`pack plugin`) + `.mcpb`         | `.mcpb` emitter; hooks ceiling; org-plugins positioning — [#38](https://github.com/jckeen/agent-pack/issues/38) |
| **Claude Chat (claude.ai)**              | Partial                                              | skill ZIPs + connector recipe + project instructions | `pack chat` — [#40](https://github.com/jckeen/agent-pack/issues/40)                                             |
| **Codex (OpenAI)**                       | Export adapter exists                                | `.codex/*` + AGENTS.md                               | `import --from codex` — [#39](https://github.com/jckeen/agent-pack/issues/39)                                   |
| **ChatGPT (consumer GPT)**               | `import --from chatgpt-gpt` (human-seeded)           | via `pack chat`                                      | `import --from chatgpt-gpt` + OpenAPI→MCP transpiler — [#41](https://github.com/jckeen/agent-pack/issues/41)    |

## Atom portability (validated against live docs)

The `PortabilityCeiling` model in `packages/core/src/portability.ts` matches the
June 2026 docs. Per surface:

| Atom                   | Code (terminal)  | CoWork                                                                  | Chat                                   | Codex     |
| ---------------------- | ---------------- | ----------------------------------------------------------------------- | -------------------------------------- | --------- |
| `skill`                | full             | full (plugin)                                                           | **full** (universal)                   | full      |
| `mcp_server` (remote)  | full             | full                                                                    | **full** (Connector)                   | full      |
| `command`              | full             | plugin                                                                  | none → re-express as skill             | full      |
| `subagent`             | full             | plugin                                                                  | none                                   | full      |
| `hook`                 | full             | plugin (verify — [#38](https://github.com/jckeen/agent-pack/issues/38)) | none                                   | full      |
| `instruction` / `rule` | full (CLAUDE.md) | on-invoke skill                                                         | Project instructions / on-invoke skill | AGENTS.md |

Clean universal crossers are **skills + remote MCP**. Ambient instructions/rules
have no globally-ambient home off the terminal — they downgrade to on-invoke
skills (or Project instructions in Chat), and AgentPack states this honestly.

## Build sequence

Ordered by ROI-per-effort (rationale in each issue):

1. **Codex importer** — [#39](https://github.com/jckeen/agent-pack/issues/39). Cheapest, near-lossless, bidirectional.
2. **`.mcpb` emitter + CoWork repositioning** — [#38](https://github.com/jckeen/agent-pack/issues/38). One-click local MCP on CoWork/Desktop.
3. **Chat target (`pack chat`)** — [#40](https://github.com/jckeen/agent-pack/issues/40). Broadest claude.ai reach; the missing bundle layer.
4. **ChatGPT → Claude Chat** — [#41](https://github.com/jckeen/agent-pack/issues/41). The headline; builds on #39 + #40 + the OpenAPI→MCP transpiler.

### What `import --from chatgpt-gpt` does and doesn't carry

The importer takes a **human-assembled bundle** (`gpt.json` + optional
`openapi.yaml` + `knowledge/`) — there is no GPT export API, so config is seeded
by hand. It then maps:

- **Automatable:** instructions → `instruction`/`rule` atoms (governance split);
  conversation starters → a "Suggested prompts" instruction; Action `operationId`s
  → MCP tools (inputSchema + auth scheme/scopes) via the OpenAPI→MCP transpiler,
  emitted as a connector-shaped `mcp_server` atom.
- **Human judgment required:** the transpiled tools are **scaffolding, not runnable
  handlers** — stand up the real remote MCP endpoint, set its `url`, and review the
  auth scopes / least-privilege the credentials before wiring it to claude.ai.
  Decide whether `knowledge/` belongs in a `context_pack` (loaded wholesale / in a
  Project) or behind a real retrieval MCP server.
- **Cannot cross at all:** GPT config auto-extraction (no export API), GPT Store
  distribution, Apps SDK iframe widgets, and managed vector-store RAG retrieval
  semantics. The importer states each of these in its output and warnings.

## Pre-public hardening (parallel track)

Found in the same review sweep; tracked at
[#34](https://github.com/jckeen/agent-pack/issues/34) (install-recovery data-loss),
[#35](https://github.com/jckeen/agent-pack/issues/35) (sign the full artifact),
[#36](https://github.com/jckeen/agent-pack/issues/36) (registry schema),
[#37](https://github.com/jckeen/agent-pack/issues/37) (abuse-control durability),
[#38](https://github.com/jckeen/agent-pack/issues/38) (CoWork accuracy). The
command-gate RCE, the orphan-token / 409 / semver bugs, and the registry coverage
gate landed in [#33](https://github.com/jckeen/agent-pack/pull/33).
