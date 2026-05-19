# agent-pack — STATUS

Last updated: 2026-05-19 (OSS launch — Phase 4 admin UI shipped, repo public)

## Where we are

**AgentPack is OPEN SOURCE.** Standard, registry, CLI, and adapters are all MIT-licensed. The repo at `github.com/jckeen/agent-pack` is public. The hosted registry (when it lands at a stable URL) is a convenience, not a requirement — self-host is a first-class deployment shape.

**Phases 1–5 are shipped in code; v0.3.0 is one live-smoke run from promotion; Phase 6 is 🔒 gated.**

## Shipped phases

- **Phase 1** (v0.1.x, 2026-05-18): standard, manifest parser, zod schema, validator, risk + permission engines, planner, 5 adapters (claude-code, codex, cursor, chatgpt, generic), CLI (`init`, `validate`, `inspect`, `plan`, `pack export`, `doctor`), Next.js registry rendering 10 seed packs.
- **Phase 2** (v0.2.0, 2026-05-18): install engine with WAL-protected `applyInstall`, classified `planInstall`, backup engine, per-atom + per-file SHA-256 lockfile, hash-chained `history.jsonl`, recovery sweep, `verify` with drift detection, `rollback` with supersession refusal, 6 new CLI subcommands.
- **Phase 3 + Phase 5 scaffold** (v0.3.0-rc.1, 2026-05-18): `@workgraph/db` Drizzle schema (13 registry tables + 3 Auth.js tables) + queries + migration SQL; protocol module pinning wire shapes + token format + error envelopes + exit codes; `packages/core/src/registry-client/` with sha256 verification; `packages/core/src/cache/` content-addressed blob store; `packages/core/src/policy/` for `workgraph.policy.json`; full registry app with NextAuth v5 + GitHub OAuth, two-phase publish API (presigned R2 PUT + finalize), full read API, Postgres FTS search, device-code CLI auth flow, token management UI; 5 new CLI commands (`login`, `whoami`, `tokens`, `publish`, `cache`); `install` extended with remote-identity branch.
- **Phase 4** (v0.4.0-dev, 2026-05-19): `@workgraph/core/signing` cosign keyless module (Sigstore Fulcio + Rekor); `workgraph publish --sign` populates lockfile `signatures.manifest` slot; `workgraph verify --sig --strict` exits non-zero on unsigned/invalid; registry stores + serves signature + Rekor URL; pack detail page shows "Signed by @<github>" badge; admin quarantine UI at `/admin/packs` (owner-of-publisher role gate); audit-events hash-chained writer; quarantined version returns 451 + red banner on pack detail in place of install command.

## Open-source readiness (2026-05-19)

- `LICENSE` — MIT (since v0.1.1).
- `CONTRIBUTING.md` — present, accurate.
- `SECURITY.md` — present, points to GitHub Security Advisories.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml` — structured forms.
- `.github/PULL_REQUEST_TEMPLATE.md` — checklist with `pnpm verify` gate.
- README badge row: MIT · Node ≥22 · pnpm 9.15 · CI status.
- Repo visibility: PUBLIC (flipped 2026-05-19).

## Test status

- **258 tests passing** across 23 files: 178 core + 19 db + 35 cli + 26 registry (+8 new admin-status tests this session).
- All four workspace packages typecheck + lint + build cleanly.
- Registry builds Next.js 15 production output: 20 dynamic + static pages, 17 API routes (one new `/admin/packs` page + one new `/api/admin/packs/[publisher]/[pack]/versions/[version]/status` POST route).
- `pnpm verify` (typecheck + lint + test + build) exit 0 on the committed tree.

## How to bring it up locally

```bash
git clone https://github.com/jckeen/agent-pack
cd agent-pack
pnpm install
pnpm build
pnpm test
pnpm dev
# Registry UI at http://localhost:3030 in JSON-fallback mode
```

For DB-backed mode (browseable AT a public URL with real publish/install round-trips), set the env vars listed in `apps/registry/.env.example` and run `scripts/bring-up-prod.sh` — the runbook walks through Neon (or Supabase) Postgres, Cloudflare R2, and GitHub OAuth app creation.

## What's next

- **v0.3.0 promotion** — held until live smoke (`scripts/smoke-e2e.sh`) round-trips publish→install against the hosted registry. Blocked on operator-provided DATABASE_URL + R2 credentials + GitHub OAuth app + DNS.
- **Vercel preview deploy** — project linked at `keen-media/agent-pack-registry`. Initial deploy failed because `rootDirectory` needs to be set to `apps/registry` in the dashboard (Vercel CLI does not expose that field). One-click fix at https://vercel.com/keen-media/agent-pack-registry/settings, then `vercel --prod=false` from the repo root.
- **Phase 4 final touches** — live Sigstore round-trip from CI; `--require-sig` enforcement flag in v0.4.0.
- **Phase 6** (enterprise) — 🔒 **Gated.** Triggers on first paying-customer conversation about enterprise self-host. Schema slots preserved (`org_id` nullable, `audit_events` table exists, audit hash-chain writer landed). See `Plans/PHASE-6-GATE.md`.
- **Phase 7** (Workgraph integration) — `POST /api/v1/import/workgraph`, trust signals, Agent Commons publish bridge. Requires Workgraph product API + Agent Commons publishing endpoint.
- **Algorithm v6.4.0 doctrine** — proposed changes from the 2026-05-19 agent-stall investigation live in `Plans/algorithm-v6.4.0-changes.md`. Surface to user; not auto-merged.

## Living docs

- Project ISA: `ISA.md` — 267+ ISCs total. Iterating on the project IS iterating on this file.
- Wire contract: `Plans/PROTOCOL.md`.
- Roadmap: `Plans/ROADMAP.md`.
- Phase 6 gate: `Plans/PHASE-6-GATE.md`.
- Changelog: `CHANGELOG.md`.
