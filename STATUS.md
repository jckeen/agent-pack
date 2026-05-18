# agent-pack — STATUS

Last updated: 2026-05-18 (post-Phase-2 ship)

## Where we are

**v0.2.0 — Phase 2 (local install / uninstall / verify / rollback) — shipped.**

The TypeScript monorepo at `packages/core`, `packages/cli`, and `apps/registry`
implements:

- **Phase 1** (v0.1.x, shipped 2026-05-18): Standard + manifest parser + zod
  schema + validator + risk + permission engines + planner + 5 adapters
  (claude-code, codex, cursor, chatgpt export-only, generic) + CLI (`init`,
  `validate`, `inspect`, `plan`, `pack export`, `doctor`) + Next.js
  registry (`/`, `/packs`, `/packs/<publisher>/<slug>`, `/validate`,
  `/docs`) + 10 seed packs + PR-Quality example pack + hardening pass.
- **Phase 2** (v0.2.0, shipped 2026-05-18, this revision): Install engine
  with WAL-protected `applyInstall`, classified `planInstall` (created /
  modified / unchanged / conflict), backup engine, install manifest,
  per-atom + per-file SHA-256 lockfile, hash-chained `history.jsonl`,
  recovery sweep, `verify` with drift detection, `rollback` with
  supersession refusal, 6 new CLI subcommands (`install`, `uninstall`,
  `diff`, `history`, `rollback`, `verify`).

## Test status

- **172 tests passing** across 13 vitest files.
- Core coverage: **88.32%** lines / **76.04%** branches / **96.39%**
  functions / **88.32%** statements. All ≥ threshold.
- CI runs `pnpm verify` (typecheck + lint + test:coverage + build) plus
  smoke flows: validate, plan, pack export, determinism check, Phase 2
  install/verify/uninstall, and lockfile determinism.

## What's next (Phases 3-7 — out of this session)

The original `spec/09_IMPLEMENTATION_PHASES.md` defines phases 3-7. All
require external infrastructure that does not exist yet:

- **Phase 3** — Registry backend (database, users, publishers, immutable
  versions, search API). Schema slots reserved in `LockfileV1.dependencies`.
- **Phase 4** — Cryptographic signatures (Sigstore/cosign), provenance
  attestation, verified-publisher trust. Schema slots reserved in
  `LockfileV1.signatures`. The per-file checksums in the lockfile are the
  primitive Phase 4 builds on.
- **Phase 5** — Remote CLI installs (`workgraph install publisher/pack`
  over a hosted registry), version pinning, registry auth, private packs.
- **Phase 6** — Enterprise: private registries, org workspaces, SSO,
  audit logs, allowlists/blocklists, policy-as-code.
- **Phase 7** — Workgraph context-graph integration: export real
  user/team workflows as AgentPacks, private team libraries, trust graph.

A near-term local-feasible follow-on outside the registry-backend question:

- **Marker-aware merge** (Phase 3-adjacent): when two packs target the same
  instruction file (`CLAUDE.md`, `AGENTS.md`), the current install refuses
  with a clear error. Implementing per-pack block merging would let users
  layer packs. ~1 day of engineering, no infra needed.
- **`workgraph install <local-path>` with native `.gitignore` write-through**
  guarded by an explicit opt-in flag.
- **History rotation** when `history.jsonl` exceeds a threshold (bridging
  entry pattern named in `docs/install.md`).

## Living docs

- Project ISA: `ISA.md` — 150 ISCs total (Phase 1: ISC-1..68, Phase 2:
  ISC-69..150). Twelve-section canonical structure.
- Changelog: `CHANGELOG.md` — full entry for 0.2.0.
- Install reference: `docs/install.md`.
- AgentPack standard: `docs/agentpack-standard.md`.
- Security model: `docs/security.md`.
- Adapters: `docs/adapters.md`.
- CLI reference: `docs/cli.md`.
