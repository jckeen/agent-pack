# AgentPack

**The compiler and governance layer for agent configuration. Write once, install with a lockfile, govern what agents can do — and carry it to every Claude surface.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](./.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-9.15-orange)](https://pnpm.io)
[![CI](https://github.com/jckeen/agent-pack/actions/workflows/ci.yml/badge.svg)](https://github.com/jckeen/agent-pack/actions/workflows/ci.yml)

One `AGENTPACK.yaml` describes a bundle of agent configuration — skills, rules, hooks, slash commands, subagents, MCP servers — and AgentPack does three things a hand-rolled `.claude/` directory can't:

1. **Governs it.** Permissions, risk level, and the exact file plan are shown _before_ anything writes to disk; a `agentpack.policy.json` can refuse installs that exceed a risk ceiling or pull from un-allowlisted sources.
2. **Installs it safely.** A content-addressed engine produces a lockfile, hash-chained history, drift detection, and atomic rollback — npm-grade discipline for agent config, with surgical merge into your existing `CLAUDE.md`.
3. **Carries it across surfaces.** Compile to a Claude Code **plugin** (reaches Code, Cowork, Desktop, and the web Directory) or run a remote **MCP connector** (reaches _every_ surface, including claude.ai chat and mobile) — with honest per-atom **portability ceilings** so you know what travels and what's terminal-only.

It also compiles to **Codex**, **Cursor**, **ChatGPT Apps**, and a generic `AGENTS.md` target — which is exactly what agents like **Google Antigravity** consume (Antigravity auto-loads a workspace's `AGENTS.md` and `GEMINI.md`; verified against agy 1.1.0, and its skills use the same [Agent Skills](https://agentskills.io) `SKILL.md` format AgentPack emits). AgentPack is **MIT-licensed** and open source through and through; the standard, the CLI, the registry, the connector, and the adapters are all in this repo and stay free forever.

> **Status:** Phases 1–5 are shipped in code; the hosted registry is **not yet live** (DB + R2 + OAuth provisioning pending). Today the working path is **git-source install** — `agentpack install github:owner/repo@ref#subpath` works without any hosted infrastructure. Cross-surface reach spans four compile/import targets — `pack plugin`, `pack mcpb`, `pack chat`, and `import` (Claude / Codex / ChatGPT-GPT) — plus `@agentpack/connector`, a remote-MCP prototype that reaches every surface. v0.3.0 promotion is held until a live publish→install smoke round-trips against the hosted registry. Phase 6 (enterprise / orgs / SSO) is 🔒 [gated](./Plans/PHASE-6-GATE.md). For the current shipped state and version see [`STATUS.md`](./STATUS.md), [`CHANGELOG.md`](./CHANGELOG.md), and [`Plans/ROADMAP.md`](./Plans/ROADMAP.md).

---

## Why AgentPack

Two real problems, one tool:

- **No discipline.** A shared `.claude/` directory committed to git has no lockfile, no drift detection, no clean uninstall, and clobbers whatever was already in your `CLAUDE.md`. Nobody can see what a configuration bundle will _do_ to their machine before installing it — and an org has no way to refuse a pack that ships a `bash -c` hook from an un-allowlisted source.
- **No reach.** What you carefully set up in the terminal (Claude Code) doesn't follow you to claude.ai, Desktop, Cowork, or mobile. Each surface is an island.

AgentPack answers the first with a permissioned planner that runs _before_ any export, a content-addressed install engine (lockfile + hash-chained history + drift detection + atomic rollback + surgical merge into your existing `CLAUDE.md`), an `agentpack.policy.json` enforcer, and cosign keyless signatures with a transparency-log inclusion proof. It answers the second by compiling the same pack to a Claude Code **plugin** and a remote **MCP connector** — honestly labeling, per atom, how far each piece travels (skills + MCP reach everywhere; hooks and ambient `CLAUDE.md` are Claude-Code-only).

The governance is the durable part — the thing the platforms are slowest to build. Portability is real but increasingly absorbed natively (account-level Skills, the Directory, account connectors); AgentPack rides those rails rather than fighting them.

---

## Quickstart (≤5 minutes)

> AgentPack isn't on npm yet (planned for v0.3.0 promotion). For now, get the CLI by cloning + building. Once published, the same commands will work via `npx agentpack` or a global install.

**1. Clone and build the CLI:**

```bash
git clone https://github.com/jckeen/agent-pack
cd agent-pack
pnpm install
pnpm build
pnpm test                                  # full suite — see STATUS.md for current count

# expose the freshly-built CLI on your PATH for the rest of this quickstart:
alias agentpack="node $(pwd)/packages/cli/dist/index.js"
```

**2. Install a pack directly from a git ref — no registry required:**

```bash
agentpack install github:jckeen/agent-pack@master#examples/pr-quality \
  --target claude-code --profile safe \
  --project ./my-project --yes
```

The CLI fetches the manifest from `raw.githubusercontent.com` at the named ref, derives the file list from `AGENTPACK.yaml`, materializes everything into a tmpdir, and runs the same WAL-protected install pipeline used for local paths. Lockfile, history, verify, and rollback all work identically.

See [`docs/git-source.md`](./docs/git-source.md) for the full git-source syntax (`github:owner/repo[@ref][#subpath]`, `github.com/owner/repo`, branch refs with slashes, signature notes).

**3. Inspect + manage:**

```bash
# Validate, inspect, plan — all read-only
agentpack validate examples/pr-quality
agentpack inspect  examples/pr-quality
agentpack plan     examples/pr-quality --target claude-code --profile safe

# Compile to native files (export — never touches your project)
agentpack pack export examples/pr-quality \
  --target claude-code --profile safe --out dist/claude

# Install into a project (Phase 2): diff → backup → write → lockfile + history.
# Shared files MERGE: an existing CLAUDE.md keeps the user's content and other
# packs' blocks; .claude/settings.json and .mcp.json are deep-merged.
agentpack install examples/pr-quality \
  --target claude-code --profile safe \
  --project /tmp/my-claude-project --yes

# Machine-readable output for agents: one JSON object with the plan + result
agentpack install examples/pr-quality \
  --target claude-code --profile safe \
  --project /tmp/my-claude-project --yes --json

# Drift detection, rollback, history (Phase 2)
agentpack verify agentpack.pr-quality --project /tmp/my-claude-project
agentpack uninstall agentpack.pr-quality --project /tmp/my-claude-project --yes
agentpack history --project /tmp/my-claude-project

# Sign on publish (Phase 4 — keyless via Sigstore Fulcio + Rekor; requires a hosted registry)
agentpack publish examples/pr-quality --sign

# Verify a signed install (Phase 4) — --sig FAILS on an unsigned lockfile;
# use --sig-if-present to pass when no signature is recorded
agentpack verify agentpack.pr-quality --project /tmp/my-claude-project --sig
```

### Hosted registry (optional)

You don't _need_ a hosted registry to use AgentPack — git is the default distribution. The registry exists as an optional convenience for cross-org discovery, schema-validated metadata at index time, admin-side quarantine of compromised versions, and the eventual enterprise self-host path. See [`docs/registry.md`](./docs/registry.md) for when it earns its keep.

To browse the registry web app locally (boots in JSON-fallback mode without any env vars):

```bash
pnpm dev
# → http://localhost:3030
```

---

## What's an AgentPack?

The manifest is `AGENTPACK.yaml`. Each pack is composed of **atoms** — the smallest installable unit:

| Atom type      | Compiles to (examples)                                                             |
| -------------- | ---------------------------------------------------------------------------------- |
| `instruction`  | `CLAUDE.md`, `AGENTS.md`, `project-instructions.md`, generic instruction docs      |
| `rule`         | `.cursor/rules/*.mdc`, scoped sections in `CLAUDE.md` / `AGENTS.md`                |
| `skill`        | `.claude/skills/<name>/`, `.agents/skills/<name>/`, `skills/<name>/` (Agent Skills) |
| `hook`         | `.claude/settings.json` hooks, `.codex/hooks.json` (high risk by policy)           |
| `command`      | `.claude/commands/*.md` slash commands, skill folders, MCP tool stubs              |
| `subagent`     | `.claude/agents/*.md`, `.codex/agents/*.toml`                                      |
| `mcp_server`   | `.claude/settings.json#mcpServers`, `.codex/config.toml`, `.cursor/mcp.json`       |
| `plugin`       | ChatGPT Apps SDK skeleton, editor plugin metadata                                  |
| `workflow`     | section in `CLAUDE.md` / `AGENTS.md`                                               |
| `context_pack` | exported context bundle (sensitivity declared)                                     |
| `template`     | starter docs / configs / checklists                                                |
| `eval`         | regression prompts, behavioral checks                                              |

Install profiles (**safe → standard → full → enterprise**) let you opt into risk explicitly. The CLI shows risk, permissions, secrets, and the exact file plan before any export touches disk.

---

## Where a pack runs — across Claude's surfaces

The thing you configure in the terminal mostly doesn't follow you to claude.ai, Desktop, Cowork, or mobile — each surface is its own island. AgentPack bridges what's bridgeable through three vehicles, and is honest about the rest:

| Vehicle            | Command                 | Carries                                               | Reaches                                            |
| ------------------ | ----------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| **Local install**  | `agentpack install`     | everything, incl. hooks + ambient `CLAUDE.md`         | Claude Code only                                   |
| **Plugin**         | `agentpack pack plugin` | skills, commands, subagents, MCP, hooks               | Code, Cowork, Desktop, the web **Directory**       |
| **Local bundle**   | `agentpack pack mcpb`   | a local stdio `mcp_server` as a `.mcpb`               | one-click **local** MCP on Cowork + Desktop        |
| **Chat artifacts** | `agentpack pack chat`   | skill ZIPs + `connectors.json` + project instructions | **claude.ai (Chat)** — copy-paste install steps    |
| **MCP connector**  | `@agentpack/connector`  | skills/commands/instructions as prompts + resources   | **every** surface, incl. claude.ai chat and mobile |

The plugin format **is** the Claude Cowork install format — one `/plugin install` (or file upload) reaches Code, Cowork, Desktop, and the web Directory. [Hooks are a Cowork-supported plugin component](https://claude.com/docs/cowork/3p/extensions), so they ride the plugin to Cowork (not Code-only).

Every atom type has a **portability ceiling** that `inspect` and `pack plugin` print:

| Ceiling     | Atom types                                                | Meaning                                       |
| ----------- | --------------------------------------------------------- | --------------------------------------------- |
| `universal` | `skill`, `mcp_server`                                     | account-level — reaches every Claude surface  |
| `plugin`    | `command`, `subagent`, `hook`, `plugin`                   | reaches plugin-aware surfaces inside a plugin |
| `sdk`       | `workflow`                                                | Agent SDK / Managed Agents only               |
| `terminal`  | `instruction`, `rule`, `context_pack`, `template`, `eval` | Claude Code only — no ambient home elsewhere  |

A pack's overall reach is bounded by its least-portable atom. Instruction/rule content (terminal-only as _ambient_ behavior) is bundled into an on-invoke `*-guidance` skill so the guidance still travels — just not ambiently. This is deliberate honesty: no vehicle can make an ambient `CLAUDE.md` work on claude.ai or Cowork, because those surfaces have no `CLAUDE.md` loader.

```bash
# Compile to a Directory-installable Claude Code plugin — this IS the Cowork install format
agentpack pack plugin examples/pr-quality --profile full --out dist-plugin
#   → /plugin marketplace add <repo> ; /plugin install pr-quality@pr-quality-marketplace

# Compile a local stdio MCP server into a .mcpb bundle (one-click LOCAL install on Cowork + Desktop)
agentpack pack mcpb examples/pr-quality --profile full --out dist-mcpb
#   → open dist-mcpb/pr-quality.mcpb in Claude Desktop, or upload it in Cowork connector settings

# Run a remote MCP connector that reaches every surface (prototype; auth-by-default)
AGENTPACK_CONNECTOR_TOKEN=$(openssl rand -hex 24) \
  node packages/connector/dist/serve.js examples/pr-quality
#   → add the /mcp URL as a Custom Connector in claude.ai or Desktop (Bearer = the token)
```

### The plugin target is the Cowork + org-governance path

`agentpack pack plugin` is not a Code-only convenience — the Claude Code plugin format **is** the install format for Claude Cowork, Desktop, and the web Directory. One compiled plugin reaches all of them.

This is where the **compiler + governance** positioning lands hardest. A governed pack (risk-scored, permission-summarized, profile-gated) compiles into a plugin that an admin distributes through Cowork **org-plugins**: drop the compiled directory into the system-wide `org-plugins/` location on each device and it becomes a **required, auto-installed, policy-locked** plugin org-wide — with org precedence over user plugins and per-tool policy locks. AgentPack's job is to make the artifact you drop in there auditable and reproducible from a single source pack. See [`docs/cli.md`](docs/cli.md) for the admin-distribution flow.

---

## Repository layout

```text
agent-pack/
├── packages/
│   ├── core/                 # @agentpack/core: schema + parser + risk + permissions + planner + adapters + signing + portability + plugin emit
│   ├── cli/                  # @agentpack/cli: agentpack CLI binary
│   ├── connector/            # @agentpack/connector: remote MCP connector (prototype) — cross-surface reach
│   └── db/                   # @agentpack/db: Drizzle schema, queries, migrations
├── apps/
│   └── registry/             # @agentpack/registry: Next.js 15 App Router registry app
├── examples/
│   └── pr-quality/           # complete AgentPack — 7 atoms, 4 profiles
├── schemas/AGENTPACK.schema.json
├── seed/seed-packs.json
├── templates/                # starter manifest, CLAUDE.md, AGENTS.md, rule templates
├── docs/                     # standard, security, adapters, CLI, registry, publish, install, policy, remote-install
├── Plans/                    # ROADMAP, PROTOCOL, PHASE-6-GATE
├── scripts/                  # bring-up-prod.sh, smoke-e2e.sh, seed-import.ts
├── ISA.md                    # Project Ideal State Articulation — ISCs (test harness + done condition)
├── STATUS.md                 # Current shipped state
├── CHANGELOG.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
└── LICENSE                   # MIT
```

---

## CLI reference (highlights)

```bash
agentpack init                              # scaffold a starter AGENTPACK.yaml
agentpack import [path] --id pub.slug \
  --from claude|claude-code|codex|chatgpt-gpt  # compile an existing setup into a pack
                                            # (claude-code ingests a whole ~/.claude dir)
agentpack validate [path]                   # validate manifest
agentpack inspect [path]                    # metadata + atoms + profiles + risk
agentpack plan [path] \
  --target claude-code --profile safe       # plan + risk + permission summary
agentpack pack export [path] \
  --target codex --profile full --out dist/ # write platform-native files
agentpack pack plugin [path] \
  --profile full --out dist-plugin          # compile a Directory-installable Claude Code plugin
agentpack install [pack] \
  --target claude-code --profile safe \
  --project ./my-project --yes              # WAL-protected local install
agentpack verify [packId] --project . --sig # drift + signature check
agentpack rollback --project .              # restore from history
agentpack diff [pack] --target X --profile Y # unified diff preview
agentpack doctor                            # environment checks
agentpack login                             # device-code OAuth to a registry
agentpack publish [path] --sign             # two-phase publish + Sigstore keyless signing
agentpack tokens list | create | revoke     # API token management
agentpack cache size | prune | clear        # offline blob cache housekeeping
```

Full reference: [`docs/cli.md`](./docs/cli.md).

---

## Adapters

| Target          | Output surface                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **claude-code** | `CLAUDE.md`, `.claude/skills/*`, `.claude/commands/*`, `.claude/agents/*`, `.claude/settings.json` (hooks), `.mcp.json` (MCP servers) |
| **codex**       | `AGENTS.md`, `.codex/config.toml`, `.codex/hooks.json`, `.agents/skills/*`, `.codex/agents/*.toml`                                     |
| **cursor**      | `AGENTS.md`, `.cursor/rules/*.mdc`, `.cursor/mcp.json`                                                                                |
| **chatgpt**     | `project-instructions.md`, `app-manifest.json`, `mcp-server/` skeleton (export-only)                                                  |
| **generic**     | `AGENTS.md`, `skills/*`, `README-agent.md`, `agentpack.json`                                                                          |

The **generic** target's `AGENTS.md` is also the path to agents without a dedicated adapter: **Google Antigravity** auto-loads a workspace's `AGENTS.md`/`GEMINI.md` (verified against agy 1.1.0) and reads Agent-Skills-spec `SKILL.md` folders, so `pack export --target generic` reaches it today. We dogfood this: Antigravity runs the runtime-verification lane in this repo's own multi-agent workflow.

Every adapter:

- Is **deterministic** — two runs produce byte-identical output.
- Wraps instruction content in `<!-- BEGIN AGENTPACK: <id> --> … <!-- END AGENTPACK: <id> -->` markers — and the install engine honors them: packs coexist with each other AND with the user's own `CLAUDE.md`/`AGENTS.md` content (merge on install, surgical span removal on uninstall, fragment-level drift detection).
- Returns warnings for atoms it cannot map to its platform — never silently drops dangerous capability.
- Emits **[Agent Skills](https://agentskills.io) spec-conformant** skill folders (see below).

### Agent Skills conformance

AgentPack emits and consumes skills in the open [Agent Skills](https://agentskills.io) format and operates a layer **above** the spec: the spec defines a single skill folder (`SKILL.md` frontmatter + optional `scripts/`/`references/`/`assets/`); AgentPack adds what the spec deliberately leaves out — multi-atom packs, install discipline (lockfile, drift detection, rollback), and governance (policy enforcement, permission planning, risk gating). Every emitted skill folder is conformant: directory names are spec-normalized, `name` always matches the directory, frontmatter is YAML-safe, and AgentPack-specific extras travel under the spec's `metadata` passthrough — non-conformant sources are auto-conformed with a warning, never silently. On the way in, a `skill` atom can point at any spec-conformant skill folder (e.g. one authored against the spec directly) and it passes through byte-identical; `agentpack validate` checks skill sources against the spec rules. Output is validated against the reference `skills-ref` validator and gated by a conformance test in CI ("conformant/validated", not "certified" — there is no certification program).

Details: [`docs/adapters.md`](./docs/adapters.md).

---

## Security model

Risk is computed from atom risk levels, declared permissions, and the install profile. The model is opinionated and conservative:

- Hooks are **always** high-risk — they run shell commands after agent edits.
- Hook commands must appear verbatim in `permissions.shell.commands`; MCP servers must be declared in `permissions.mcp.servers` — and shell-escape shapes (`bash -c`, `node -e`, …) are refused in both, so neither atom type can smuggle arbitrary shell.
- `shell.execution + secrets.env + network.access + filesystem.write` raises a plan to **critical** — and a critical plan requires an explicit `--allow-critical` (a `--yes` in CI never crosses that line alone).
- Installing an **unverified** pack that ships executable content requires an explicit `--allow-exec` — `--yes` alone never crosses it. That covers `hook` / `mcp_server` atoms, **and** a `command` / `subagent` atom whose body embeds a Claude Code bang-bash directive (`` !`…` ``) that runs shell when the slash command is invoked. A plain prompt command (no `` !`…` ``) is not gated. A pack whose signature is verified via `--require-sig` is exempt, since provenance is then established. (Git sources can't be signature-verified yet, so they always fall under this gate.)
- `package.installation` and `model_provider_key.access` are critical.
- Permission categories are surfaced **only** when an included atom backs them — no leaky pack-level declarations.

Phase 2 install:

- **WAL-protected** (begin → backup → atomic writes → commit), refuses to write outside `projectRoot` (realpath + symlink-escape tests).
- **Per-file SHA-256** in the lockfile, hash-chained `history.jsonl`, deterministic across runs.

Phase 4 trust:

- **Sigstore cosign keyless** signing (OIDC → Fulcio cert + Rekor witness). No publisher-managed keys.
- `agentpack publish --sign` populates `lockfile.signatures.{manifest, cert}` (slots reserved in v0.2.0).
- `agentpack verify --sig` enforces signing by default — it exits non-zero on unsigned, signature-invalid, or quarantined packs; pass `--sig-if-present` for the lenient variant that passes when no signature is recorded. (`--strict` is a deprecated alias for `--sig`.) `--expected-signer <san>` pins the Sigstore identity (without it the CLI explicitly labels the signer as unpinned).
- Registry serves 451 on a quarantined version; admin UI at `/admin/packs` flips status.

Full details: [`docs/security.md`](./docs/security.md) and [`docs/signatures.md`](./docs/signatures.md).

---

## Roadmap (live)

| Phase | Version         | Status                                                                                                                          |
| ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1     | v0.1.x          | ✅ shipped — standard + CLI + 5 adapters + registry                                                                             |
| 2     | v0.2.0          | ✅ shipped — local install + verify + rollback + history                                                                        |
| 3     | v0.3.0-rc.1     | ✅ shipped (code) — registry backend (Drizzle schema + auth + publish + read API + search); v0.3.0 promotion held on live smoke |
| 4     | v0.4.0-dev      | ✅ shipped (code) — Sigstore keyless signing + verification + admin quarantine UI                                               |
| 5     | v0.5.0          | ✅ shipped (scaffold) — remote install, content-addressed cache, policy file                                                    |
| 6     | v0.6.0          | 🔒 **gated** — see [`Plans/PHASE-6-GATE.md`](./Plans/PHASE-6-GATE.md)                                                           |
| 7     | v0.7.0 → v1.0.0 | 📋 planned — AgentPack integration, trust graph, Agent Commons bridge                                                           |

> The current dev line is **`0.7.0-dev`**, which carries the cross-surface build-out (`pack mcpb`, `pack chat`, `import --from codex|chatgpt-gpt`) on top of Phases 1–5. The Phase 7 _roadmap_ items above (AgentPack integration, trust graph, Agent Commons bridge) remain planned.

Decisions, rationale, and revisit triggers are pinned in [`Plans/ROADMAP.md`](./Plans/ROADMAP.md). The wire contract that Phase 3+ honors is pinned in [`Plans/PROTOCOL.md`](./Plans/PROTOCOL.md).

---

## Contributing

PRs and issues are welcome. Before opening one:

- Read [`CONTRIBUTING.md`](./CONTRIBUTING.md).
- Check the published [roadmap](./Plans/ROADMAP.md) — your idea may already be planned.
- Use the structured [bug-report](./.github/ISSUE_TEMPLATE/bug_report.yml) and [feature-request](./.github/ISSUE_TEMPLATE/feature_request.yml) templates.
- Follow the [Contributor Covenant](./CODE_OF_CONDUCT.md) code of conduct.

Security issues should follow [`SECURITY.md`](./SECURITY.md) — file a private advisory rather than a public issue.

**If AgentPack is useful to you, the most helpful next step is to try the quickstart and open an issue with anything that broke.** Star the repo to follow along with Phase 6 work.

---

## Project ideal state

The project's living ideal-state articulation lives at [`ISA.md`](./ISA.md) — the test harness and the done condition expressed as testable criteria across build, standard, install engine, signing, registry API, registry UI, CLI surface, docs, and anti-criteria. It's an internal planning artifact; iterating on the project IS iterating on this file.

---

## License

[MIT](./LICENSE) © 2026 AgentPack contributors. AgentPack is **open source forever** — the standard, the CLI, the adapters, and the optional hosted registry are all MIT-licensed and free. Self-host is a first-class deployment shape. The aim is interoperability: write an agent skill once and compile conservative, reviewable output for Claude Code, Codex, Cursor, ChatGPT Apps, and a generic AGENTS.md target — how natively each platform consumes it varies (see [`docs/adapters.md`](./docs/adapters.md)).
