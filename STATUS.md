# agent-pack — STATUS

Last updated: 2026-05-18 (post Phase 3 + Phase 5 scaffold)

## Where we are

**v0.3.0-rc.1 — Phase 3 (registry backend) + Phase 5 (remote install) scaffold — landed in code.**

The TypeScript monorepo at `packages/{core,cli,db}` + `apps/registry`
implements:

- **Phase 1** (v0.1.x, shipped 2026-05-18): Standard + manifest parser + zod schema + validator + risk + permission engines + planner + 5 adapters + CLI (`init`, `validate`, `inspect`, `plan`, `pack export`, `doctor`) + Next.js registry rendering 10 seed packs.
- **Phase 2** (v0.2.0, shipped 2026-05-18): Install engine with WAL-protected `applyInstall`, classified `planInstall`, backup engine, install manifest, per-atom + per-file SHA-256 lockfile, hash-chained `history.jsonl`, recovery sweep, `verify` with drift detection, `rollback` with supersession refusal, 6 new CLI subcommands.
- **Phase 3 + Phase 5 scaffold** (v0.3.0-rc.1, this iteration):
  - `@workgraph/db` — full Drizzle schema (13 registry tables + 3 Auth.js tables), queries, migration SQL.
  - Protocol module — wire shapes (zod) for publish/read API, token format, error envelopes, exit codes.
  - `packages/core/src/registry-client/` — HTTP + in-memory clients with sha256 verification.
  - `packages/core/src/cache/` — content-addressed blob store with integrity check.
  - `packages/core/src/policy/` — `workgraph.policy.json` v1 schema + enforcement.
  - `apps/registry` — NextAuth v5 + GitHub OAuth, two-phase publish API (presigned R2 PUT + HEAD-only finalize), full read API, search via Postgres FTS, device-code CLI auth flow, token management UI.
  - 5 new CLI commands: `login`, `whoami`, `tokens (list|create|revoke)`, `publish`, `cache (size|prune|clear)`.
  - `install` extended with remote-identity branch: `workgraph install <publisher>/<pack>[@<version>] --registry <url>` plugs into existing Phase 2 install pipeline.
  - Docs: `registry.md`, `publish.md`, `remote-install.md`, `policy.md`, plus `Plans/PROTOCOL.md` as the source of truth for wire/auth/storage contracts.

## Test status

- **238 tests passing** across 21 files: 19 db + 166 core + 18 registry + 35 cli.
- All four workspace packages typecheck + build cleanly.
- Registry builds Next.js 15 production output: 19 static pages + 14 API routes.

## How to bring it up locally

```bash
# 1. Postgres
docker run -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16
export DATABASE_URL='postgres://postgres:dev@localhost:5432/postgres'

# 2. (Optional) R2 / S3-compatible — only needed for publish + manifest streaming
export R2_ENDPOINT='https://<account>.r2.cloudflarestorage.com'
export R2_ACCESS_KEY_ID='...' R2_SECRET_ACCESS_KEY='...' R2_BUCKET='agentpack-staging'

# 3. (Optional) GitHub OAuth — only needed for sign-in
export AUTH_SECRET="$(openssl rand -hex 32)"
export GITHUB_ID='Iv1.xxx' GITHUB_SECRET='...'

# 4. Apply schema + seed
pnpm db:push
pnpm seed:import

# 5. Boot
pnpm dev
# Registry UI at http://localhost:3030
```

Without any of those env vars, the registry boots in JSON-fallback mode for
local browsing; publish/auth/manifest-byte routes return 503.

## What's next (Phases 4, 6, 7 — out of this session)

- **Phase 4** (cosign signatures) — `workgraph verify --sig`, Fulcio keyless flow on publish, quarantine/yank UI. Lockfile `signatures.{manifest,cert}` slots already reserved.
- **Phase 6** (enterprise) — orgs first-class, WorkOS SSO, `audit_events` chain wiring, policy overlay. Schema already includes `audit_events` + nullable `org_id`.
- **Phase 7** (Workgraph integration) — `POST /api/v1/import/workgraph`, trust signals, Agent Commons publish bridge.

All three require external partner integration that doesn't exist in this
session: Sigstore CA trust roots, WorkOS tenant, Workgraph product API, Agent
Commons publishing endpoint.

## Living docs

- Project ISA: `ISA.md` — 267 ISCs total (Phase 1: 1-68, Phase 2: 69-150, Phase 3+5 scaffold: 151-267).
- Wire contract: `Plans/PROTOCOL.md`.
- Roadmap: `Plans/ROADMAP.md`.
- Changelog: `CHANGELOG.md`.
