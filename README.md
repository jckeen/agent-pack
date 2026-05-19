# AgentPack

**Atomic packages for AI workflows. Write once. Install anywhere agents work.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](./.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-9.15-orange)](https://pnpm.io)
[![CI](https://github.com/jckeen/agent-pack/actions/workflows/ci.yml/badge.svg)](https://github.com/jckeen/agent-pack/actions/workflows/ci.yml)

One `AGENTPACK.yaml` compiles to **Claude Code**, **Codex**, **Cursor**, **ChatGPT Apps**, and a generic AGENTS.md target — with permissions, risk, and platform compatibility visible *before* anything writes to disk. AgentPack is **MIT-licensed** and open source through and through; the standard, the CLI, the registry, and the adapters are all in this repo and stay free forever.

> **Status — 2026-05-19:** Phases 1–5 are shipped in code; the hosted registry is **not yet live** (DB + R2 + OAuth provisioning pending). Today the working path is **git-source install** — `agentpack install github:owner/repo@ref#subpath` works without any hosted infrastructure. Phase 3 (registry backend) and Phase 5 (remote install + cache + policy) landed as `v0.3.0-rc.1`; Phase 4 (Sigstore cosign keyless signing + admin quarantine UI) landed on top; v0.5 git-source install path landed 2026-05-19. v0.3.0 promotion is held until a live publish→install smoke round-trips against the hosted registry. Phase 6 (enterprise / orgs / SSO) is 🔒 [gated](./Plans/PHASE-6-GATE.md). See [`STATUS.md`](./STATUS.md) and [`Plans/ROADMAP.md`](./Plans/ROADMAP.md).

---

## Why AgentPack

AI tooling fragments across Claude Code, Codex, Cursor, ChatGPT, and every MCP-compatible host. Each platform has its own surface for instructions, rules, skills, hooks, slash commands, subagents, MCP servers, and plugins. Authors duplicate work. Users have no way to see what a configuration bundle will actually do to their machine before they install it.

AgentPack fixes that with a single portable manifest, a permissioned planner that runs *before* any export, deterministic compilation to every supported host, and a content-addressed install engine that produces a lockfile, history, drift detection, and atomic rollback. Phase 4 adds cosign keyless signatures + a transparency-log inclusion proof so users can verify a pack came from its claimed publisher before it touches their project.

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

# Install into a project (Phase 2): diff → backup → write → lockfile + history
agentpack install examples/pr-quality \
  --target claude-code --profile safe \
  --project /tmp/my-claude-project --yes

# Drift detection, rollback, history (Phase 2)
agentpack verify agentpack.pr-quality --project /tmp/my-claude-project
agentpack uninstall agentpack.pr-quality --project /tmp/my-claude-project --yes
agentpack history --project /tmp/my-claude-project

# Sign on publish (Phase 4 — keyless via Sigstore Fulcio + Rekor; requires a hosted registry)
agentpack publish examples/pr-quality --sign

# Verify a signed install (Phase 4)
agentpack verify agentpack.pr-quality --project /tmp/my-claude-project --sig --strict
```

### Hosted registry (optional)

You don't *need* a hosted registry to use AgentPack — git is the default distribution. The registry exists as an optional convenience for cross-org discovery, schema-validated metadata at index time, admin-side quarantine of compromised versions, and the eventual enterprise self-host path. See [`docs/registry.md`](./docs/registry.md) for when it earns its keep.

To browse the registry web app locally (boots in JSON-fallback mode without any env vars):

```bash
pnpm dev
# → http://localhost:3030
```

---

## What's an AgentPack?

The manifest is `AGENTPACK.yaml`. Each pack is composed of **atoms** — the smallest installable unit:

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

---

## Repository layout

```text
agent-pack/
├── packages/
│   ├── core/                 # @agentpack/core: schema + parser + risk + permissions + planner + adapters + signing
│   ├── cli/                  # @agentpack/cli: agentpack CLI binary
│   └── db/                   # @agentpack/db: Drizzle schema, queries, migrations
├── apps/
│   └── registry/             # @agentpack/registry: Next.js 15 App Router registry app
├── examples/
│   └── pr-quality/           # complete AgentPack — 7 atoms, 4 profiles
├── schemas/AGENTPACK.schema.json
├── seed/seed-packs.json
├── templates/                # starter manifest, CLAUDE.md, AGENTS.md, rule templates
├── docs/                     # standard, security, adapters, CLI, registry, publish, install, policy, remote-install
├── Plans/                    # ROADMAP, PROTOCOL, PHASE-6-GATE, algorithm-v6.4.0 changes
├── scripts/                  # bring-up-prod.sh, smoke-e2e.sh, seed-import.ts
├── ISA.md                    # Project Ideal State Articulation — 267 ISCs (test harness + done condition)
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
agentpack validate [path]                   # validate manifest
agentpack inspect [path]                    # metadata + atoms + profiles + risk
agentpack plan [path] \
  --target claude-code --profile safe       # plan + risk + permission summary
agentpack pack export [path] \
  --target codex --profile full --out dist/ # write platform-native files
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

| Target        | Output surface |
|---------------|----------------|
| **claude-code** | `CLAUDE.md`, `.claude/skills/*`, `.claude/agents/*`, `.claude/settings.json` (hooks + MCP) |
| **codex**       | `AGENTS.md`, `.codex/config.toml`, `.codex/hooks.json`, `.codex/skills/*`, `.codex/agents/*.toml` |
| **cursor**      | `AGENTS.md`, `.cursor/rules/*.mdc`, `.cursor/mcp.json` |
| **chatgpt**     | `project-instructions.md`, `app-manifest.json`, `mcp-server/` skeleton (export-only) |
| **generic**     | `AGENTS.md`, `skills/*`, `README-agent.md`, `agentpack.json` |

Every adapter:

- Is **deterministic** — two runs produce byte-identical output.
- Wraps instruction content in `<!-- BEGIN AGENTPACK: <id> --> … <!-- END AGENTPACK: <id> -->` markers so multiple packs can coexist in one file.
- Returns warnings for atoms it cannot map to its platform — never silently drops dangerous capability.

Details: [`docs/adapters.md`](./docs/adapters.md).

---

## Security model

Risk is computed from atom risk levels, declared permissions, and the install profile. The model is opinionated and conservative:

- Hooks are **always** high-risk — they run shell commands after agent edits.
- MCP servers requiring secrets/env are high.
- `shell.execution + secrets.env + network.access + filesystem.write` raises a plan to **critical**.
- `package.installation` and `model_provider_key.access` are critical.
- Permission categories are surfaced **only** when an included atom backs them — no leaky pack-level declarations.

Phase 2 install:

- **WAL-protected** (begin → backup → atomic writes → commit), refuses to write outside `projectRoot` (realpath + symlink-escape tests).
- **Per-file SHA-256** in the lockfile, hash-chained `history.jsonl`, deterministic across runs.

Phase 4 trust:

- **Sigstore cosign keyless** signing (OIDC → Fulcio cert + Rekor witness). No publisher-managed keys.
- `agentpack publish --sign` populates `lockfile.signatures.{manifest, cert}` (slots reserved in v0.2.0).
- `agentpack verify --sig --strict` exits non-zero on unsigned, signature-invalid, or quarantined packs.
- Registry serves 451 on a quarantined version; admin UI at `/admin/packs` flips status.

Full details: [`docs/security.md`](./docs/security.md) and [`docs/signatures.md`](./docs/signatures.md).

---

## Roadmap (live)

| Phase | Version | Status |
|------|---------|--------|
| 1 | v0.1.x | ✅ shipped — standard + CLI + 5 adapters + registry |
| 2 | v0.2.0 | ✅ shipped — local install + verify + rollback + history |
| 3 | v0.3.0-rc.1 | ✅ shipped (code) — registry backend (Drizzle schema + auth + publish + read API + search); v0.3.0 promotion held on live smoke |
| 4 | v0.4.0-dev | ✅ shipped (code) — Sigstore keyless signing + verification + admin quarantine UI |
| 5 | v0.5.0 | ✅ shipped (scaffold) — remote install, content-addressed cache, policy file |
| 6 | v0.6.0 | 🔒 **gated** — see [`Plans/PHASE-6-GATE.md`](./Plans/PHASE-6-GATE.md) |
| 7 | v0.7.0 → v1.0.0 | 📋 planned — AgentPack integration, trust graph, Agent Commons bridge |

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

[MIT](./LICENSE) © 2026 AgentPack contributors. AgentPack is **open source forever** — the standard, the CLI, the adapters, and the optional hosted registry are all MIT-licensed and free. Self-host is a first-class deployment shape. The aim is interoperability: write an agent skill once and have Claude Code, Codex, Cursor, ChatGPT Apps, and any MCP-compatible host see it as native.
