# AgentPack + Workgraph Registry

**Atomic packages for AI workflows. Write once. Install anywhere agents work.**

This repository is the reference implementation of the **AgentPack standard** and the **Workgraph Registry** — a TypeScript monorepo containing:

- `packages/core` — `@workgraph/core`: schema, parser, validator, permission summary engine, risk engine, planner, and platform adapters.
- `packages/cli` — the `workgraph` command-line tool: `init`, `validate`, `inspect`, `plan`, `pack export`, `doctor`.
- `apps/registry` — the Workgraph Registry web app (Next.js App Router) for browsing packs, viewing risk/permissions, and validating manifests.
- `examples/pr-quality` — a complete example pack (Pull Request Quality) exercising every atom type.
- `spec/` — the source spec packet that drove this build (product, standard, architecture, security, adapter, data, seed, phases).
- `docs/` — top-level documentation for the standard, security model, adapters, and CLI.

The tagline is the goal: one `AGENTPACK.yaml` compiles to Claude Code, Codex, Cursor, ChatGPT Apps, and a generic AGENTS.md target — with permissions, risk, and platform compatibility visible **before** install.

## What's an AgentPack?

An AgentPack is a portable bundle of AI agent behavior. The manifest is `AGENTPACK.yaml`. Each pack is composed of **atoms** — the smallest installable unit:

| Atom type      | Compiles to (examples)                                                            |
|----------------|-----------------------------------------------------------------------------------|
| `instruction`  | `CLAUDE.md`, `AGENTS.md`, `project-instructions.md`, generic instruction docs     |
| `rule`         | `.cursor/rules/*.mdc`, scoped sections in `CLAUDE.md` / `AGENTS.md`               |
| `skill`        | `.claude/skills/<name>/`, `.codex/skills/<name>/`, `skills/<name>/` (Agent Skills) |
| `hook`         | `.claude/settings.json` hooks, `.codex/hooks.json` (high risk by policy)          |
| `command`      | skill-style folders, MCP tool stubs                                               |
| `subagent`     | `.claude/agents/*.md`, `.codex/agents/*.toml`                                     |
| `mcp_server`   | `.claude/settings.json#mcpServers`, `.codex/config.toml`, `.cursor/mcp.json`      |
| `plugin`       | ChatGPT Apps SDK skeleton, editor plugin metadata                                 |
| `workflow`     | section in `CLAUDE.md` / `AGENTS.md`                                              |
| `context_pack` | exported context bundle (sensitivity declared)                                    |
| `template`     | starter docs / configs / checklists                                               |
| `eval`         | regression prompts, behavioral checks                                             |

Install profiles (**safe → standard → full → enterprise**) let you opt into risk explicitly. The CLI shows risk, permissions, secrets, and the exact file plan before any export touches disk.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test

# Validate the bundled example
pnpm cli validate examples/pr-quality

# Plan an install for Claude Code, safe profile
pnpm cli plan examples/pr-quality --target claude-code --profile safe

# Compile to native files (export-only — writes under --out, never touches your project)
pnpm cli pack export examples/pr-quality --target claude-code --profile safe --out dist/claude
pnpm cli pack export examples/pr-quality --target codex      --profile safe --out dist/codex
pnpm cli pack export examples/pr-quality --target cursor     --profile safe --out dist/cursor
pnpm cli pack export examples/pr-quality --target chatgpt    --profile safe --out dist/chatgpt
pnpm cli pack export examples/pr-quality --target generic    --profile safe --out dist/generic

# Install into a project (Phase 2): diff → confirm → backup → write → lockfile + history
pnpm cli install examples/pr-quality --target claude-code --profile safe --project /path/to/project --dry-run
pnpm cli install examples/pr-quality --target claude-code --profile safe --project /path/to/project

# Drift detection
pnpm cli verify workgraph.pr-quality --project /path/to/project

# Undo
pnpm cli uninstall workgraph.pr-quality --project /path/to/project
pnpm cli rollback --project /path/to/project
pnpm cli history --project /path/to/project

# Browse the registry
pnpm dev
# → http://localhost:3030
```

## Repository layout

```text
agent-pack/
├── package.json            # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── ISA.md                  # Project ideal-state articulation (lives with the project)
├── README.md
├── packages/
│   ├── core/               # @workgraph/core
│   │   ├── src/
│   │   │   ├── schema/             # zod schema + TypeScript types
│   │   │   ├── parser/             # YAML loader
│   │   │   ├── validator/          # structural + semantic validation
│   │   │   ├── permissions/        # PermissionSummary engine
│   │   │   ├── risk/               # RiskSummary engine
│   │   │   ├── planner/            # resolveAtoms + createInstallPlan
│   │   │   ├── adapters/           # 5 adapters + shared types
│   │   │   ├── exports/            # exportPack convenience entry
│   │   │   └── seed/               # SEED_PACKS for the registry
│   │   └── tests/
│   └── cli/                # @workgraph/cli (binary: `workgraph`)
│       └── src/
│           ├── commands/           # init, validate, inspect, plan, pack, doctor
│           └── lib/
├── apps/
│   └── registry/           # @workgraph/registry (Next.js App Router)
│       ├── app/
│       │   ├── packs/
│       │   ├── packs/[publisher]/[slug]/
│       │   ├── validate/
│       │   └── docs/
│       ├── components/             # PackCard, RiskBadge, CompatibilityMatrix, …
│       └── lib/                    # server-only helpers
├── examples/
│   └── pr-quality/         # complete AgentPack — 7 atoms, 4 profiles
├── schemas/AGENTPACK.schema.json
├── seed/seed-packs.json
├── templates/              # AGENTS.md / CLAUDE.md / rule / README-agent templates
├── docs/                   # standard.md, security.md, adapters.md, cli.md
└── spec/                   # build packet (the source brief)
```

## CLI

```bash
workgraph init                              # scaffold a starter AGENTPACK.yaml
workgraph validate [path]                   # validate manifest
workgraph inspect [path]                    # print metadata, atoms, profiles, risk
workgraph plan [path] \
  --target claude-code --profile safe       # plan + risk + permission summary
workgraph pack export [path] \
  --target claude-code --profile safe \
  --out dist/claude                         # write platform-native files
workgraph doctor                            # environment checks
```

See [`docs/cli.md`](./docs/cli.md) for the full reference.

## Adapters

Five adapters ship in MVP:

- **claude-code** — `CLAUDE.md`, `.claude/skills/*`, `.claude/agents/*`, `.claude/settings.json` (hooks + MCP)
- **codex** — `AGENTS.md`, `.codex/config.toml`, `.codex/hooks.json`, `.codex/skills/*`, `.codex/agents/*.toml`
- **cursor** — `AGENTS.md`, `.cursor/rules/*.mdc`, `.cursor/mcp.json`
- **chatgpt** — `project-instructions.md`, `app-manifest.json`, `mcp-server/` skeleton (export-only)
- **generic** — `AGENTS.md`, `skills/*`, `README-agent.md`, `agentpack.json`

Every adapter:

- Is **deterministic** — two runs produce byte-identical output.
- Wraps instruction content in `<!-- BEGIN AGENTPACK: <id> --> … <!-- END AGENTPACK: <id> -->` markers so multiple packs can coexist in one file.
- Returns warnings for atoms it cannot map to its platform, never silently drops dangerous capability.

Details: [`docs/adapters.md`](./docs/adapters.md).

## Security model

Risk is computed from atom risk levels, declared permissions, and the install profile. The model is opinionated and conservative:

- Hooks are **always** high-risk (they run shell commands after agent edits).
- MCP servers requiring secrets/env are high.
- The combination of `shell.execution + secrets.env + network.access + filesystem.write` raises a plan to **critical**.
- `package.installation` and `model_provider_key.access` are critical.
- Permission categories are surfaced **only** when an included atom backs them — no leaky pack-level declarations.

`workgraph` never writes outside `--out` during `pack export`. Real install into a project root is Phase 2 (not in MVP).

Details: [`docs/security.md`](./docs/security.md).

## Registry web app

`apps/registry` is a Next.js App Router app rendering the registry UI:

- `/` — product positioning + featured packs
- `/packs` — browseable seed-pack list with tag, risk, and platform filters
- `/packs/[publisher]/[slug]` — detail page with compatibility matrix, profile-aware permission summary, atom list, raw manifest viewer, install command box
- `/validate` — paste a manifest, get full validation result (the same engine the CLI uses)
- `/docs` — standard / security / adapters / CLI summary

The registry uses static seed data in MVP. The seam to a real registry API exists in `apps/registry/lib/manifest.ts` and `@workgraph/core`'s seed module.

## Limitations (MVP, by design)

- **No actual install** into a user's project root. `pack export` writes to `--out`; the install / uninstall / rollback flow is Phase 2.
- **No registry backend.** Seed JSON is the source of truth.
- **No signatures / provenance verification.** Schema fields are present; cryptographic verification is Phase 4.
- **ChatGPT Apps adapter is export-only.** The SDK surface is still evolving; output is conservatively labeled and must be reviewed before registering with ChatGPT.
- **Cursor hooks are not emitted** — no stable target. They appear as warnings.

See `spec/09_IMPLEMENTATION_PHASES.md` for the full roadmap.

## Project ideal state

The project's living ideal-state articulation (ISA) is in [`ISA.md`](./ISA.md) at the repo root — 68 testable criteria across build, schema, permissions, risk, CLI, adapter outputs, registry routes, documentation, and anti-criteria. It's the test harness and the done condition.

## License

MIT — see `LICENSE` (forthcoming).
