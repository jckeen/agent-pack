# agent-pack — STATUS

Last updated: 2026-06-13 (deferred-verify issue sweep — all of #14–#21 resolved + connector auth + registry hardening; see CHANGELOG 0.6.11 / ISA Iteration-9. Prior: Agent Skills spec conformance, CHANGELOG 0.6.9)

## Where we are

**AgentPack is OPEN SOURCE.** Standard, registry, CLI, connector, and adapters are all MIT-licensed. **Git is the default distribution mechanism** as of v0.5 — `agentpack install github:owner/repo@ref` works without any hosted registry. The hosted registry stays available as an optional convenience for cross-org discovery and the enterprise self-host path (Phase 6 — gated).

**Phases 1–5 are shipped in code; v0.5 git-source landed 2026-05-19; iteration-6 (2026-06-10) landed shared-file merge semantics; iteration-7 (2026-06-12) added cross-surface reach + a security/usability hardening sweep — see CHANGELOG 0.6.3→0.6.7; iteration-8 (2026-06-12) landed Agent Skills spec conformance (emit + ingest + CI gate, CHANGELOG 0.6.9); v0.3.0 registry promotion held on live smoke; Phase 6 🔒 gated.**

## Iteration-9 highlights (2026-06-13)

- **All eight deferred-verify issues (#14–#21) resolved.** Six were already fixed in code (drift-sweep had migrated them as verification tasks, not open defects) and now carry named regression tests; two needed real work. See ISA Iteration-9 / CHANGELOG 0.6.11.
- **Signer-identity enforcement (#14)**: `evaluateSignerGate` pins the acceptable Sigstore signer from `--expected-signer` ∪ policy `install.allowedSigners`; `install.requireIdentity` refuses an unpinned signer. The registry-side per-publisher bound-SAN remains a follow-up gated on the live registry.
- **Typed exit codes (#20)**: `failCleanly` now maps domain errors to the pinned taxonomy (not-found → 8, integrity → 7, conflict → 9) instead of collapsing to 1.
- **Connector auth (security)**: the remote-MCP connector is now auth-by-default — `AGENTPACK_CONNECTOR_TOKEN` (≥16 chars) required or fail-closed start, constant-time bearer compare, DNS-rebinding Host/Origin allowlist.
- **Registry hardening**: `verifyBearer` 45 s TTL cache; audit-fork (#15) + admin-CSRF (#16) regression tests backfilled; `pack_signatures_signer_san_idx` schema drift fixed; drizzle-kit `meta/` journal baseline (so `db:generate` reports no drift).
- **Tests**: `pnpm verify` exit 0 — **484** (320 core + 40 cli + 19 db + 33 connector + 72 registry).

## Iteration-8 highlights (2026-06-12)

- **Agent Skills spec conformance** (agentskills.io): every emitted skill folder passes the official `skills-ref` reference validator — the audit found and fixed YAML breakage on `: ` in descriptions, non-spec frontmatter passed through, name↔directory mismatches, and illegal characters in skill directory names. New `packages/core/src/skills/agentskills.ts` is the single spec module (validate/normalize/render/conform); spec-extra fields travel under the spec's `metadata` passthrough.
- **Ingestion**: a `skill` atom can wrap any spec-conformant skill folder (round-trips byte-identical); `agentpack validate` flags non-conformant skill sources as warnings.
- **CI gate**: `agentskills-conformance.test.ts` (32 tests incl. adversarial fixtures) blocks regression. Tests: core 272 → 304; `pnpm verify` exit 0.

## Iteration-7 highlights (2026-06-12)

- **Cross-surface reach**: `agentpack pack plugin` compiles a pack into a Claude Code **plugin** (Directory-installable — Code, Cowork, Desktop, web); `@agentpack/connector` is a remote-MCP prototype reaching every surface incl. claude.ai chat and mobile. Per-atom **portability ceilings** (universal/plugin/sdk/terminal) surfaced in `inspect`, with instruction/rule content bundled as an on-invoke guidance skill (honest: hooks + ambient CLAUDE.md stay terminal-only).
- **Security + usability sweep** (joint Claude + Codex review): registry token-scope self-grant P0 fixed; MCP shell-escape gate extended to inline-eval interpreters; marker-forgery defang; rollback-of-reinstall correctness; QA polish (Node ≥22 unified, uninstall wording, `--fail-on-unsupported`).
- **Registry pre-launch hardening**: atomic publish-finalize transaction, rate limiting, device-code entropy 32→64 bits, pagination count. Registry still pre-launch.
- **Tests**: `pnpm verify` exit 0 — core 272 + cli 40 + db 19 + connector 4 + registry 43.

## Iteration-6 highlights (2026-06-10)

- **Merge semantics**: installs coexist with user `CLAUDE.md`/`AGENTS.md` and other packs (marker-span merge + JSON deep-merge, fragment-level verify, surgical uninstall). The README's coexistence promise is now real.
- **Adapter fidelity**: MCP servers → `.mcp.json` (Claude Code never read settings.json#mcpServers), command atoms → `.claude/commands/` (slash commands actually register), hooks schema-clean with `Edit|Write` matcher, rule bodies rendered (were silently dropped), codex `.codex/*` outputs honestly labeled (verified vs Codex 0.128.0: only AGENTS.md is consumed project-level).
- **git-source rewrite**: tree-API fetch at pinned SHA (old code fetched a manifest field no pack sets — git installs were silently empty), GITHUB_TOKEN auth (private repos), actionable 401/403/404/rate-limit errors.
- **Data-loss fixes**: failed installs restore backups instead of unlinking user files; recovery sweep requires the install manifest before roll-forward and restores backups on rollback; uninstall scans before mutating; second-target installs refused instead of orphaning.
- **Security**: MCP command gate (no `bash -c` smuggling), `--expected-signer` identity pinning + honest unpinned-signer messaging, registry manifest sha256 verification, `--allow-critical` risk ceiling.
- **Agent ergonomics**: non-TTY confirm exits 2 instead of hanging/false-success; `--json` on install/plan; exit-code tightening (declined=1, whoami logged-out=1, dry-run conflicts=2, not-found=8).

## Shipped phases

- **Phase 1** (v0.1.x, 2026-05-18): standard, manifest parser, zod schema, validator, risk + permission engines, planner, 5 adapters (claude-code, codex, cursor, chatgpt, generic), CLI (`init`, `validate`, `inspect`, `plan`, `pack export`, `doctor`), Next.js registry rendering 10 seed packs.
- **Phase 2** (v0.2.0, 2026-05-18): install engine with WAL-protected `applyInstall`, classified `planInstall`, backup engine, per-atom + per-file SHA-256 lockfile, hash-chained `history.jsonl`, recovery sweep, `verify` with drift detection, `rollback` with supersession refusal, 6 new CLI subcommands.
- **Phase 3 + Phase 5 scaffold** (v0.3.0-rc.1, 2026-05-18): `@agentpack/db` Drizzle schema (13 registry tables + 3 Auth.js tables) + queries + migration SQL; protocol module pinning wire shapes + token format + error envelopes + exit codes; `packages/core/src/registry-client/` with sha256 verification; `packages/core/src/cache/` content-addressed blob store; `packages/core/src/policy/` for `agentpack.policy.json`; full registry app with NextAuth v5 + GitHub OAuth, two-phase publish API (presigned R2 PUT + finalize), full read API, Postgres FTS search, device-code CLI auth flow, token management UI; 5 new CLI commands (`login`, `whoami`, `tokens`, `publish`, `cache`); `install` extended with remote-identity branch.
- **Phase 4** (v0.4.0-dev, 2026-05-19): `@agentpack/core/signing` cosign keyless module (Sigstore Fulcio + Rekor); `agentpack publish --sign` populates lockfile `signatures.manifest` slot; `agentpack verify --sig --strict` exits non-zero on unsigned/invalid; registry stores + serves signature + Rekor URL; pack detail page shows "Signed by @<github>" badge; admin quarantine UI at `/admin/packs` (owner-of-publisher role gate); audit-events hash-chained writer; quarantined version returns 451 + red banner on pack detail in place of install command.
- **v0.5 git-source** (2026-05-19, this session): `@agentpack/core/git-source` — `parseGitId("github:owner/repo[@ref][#subpath]")` + `fetchGitPack(source)` materialize a tmpRoot via `raw.githubusercontent.com` per-file fetch. CLI `install` command source detection order: local path → git source → registry id. 11 new vitest cases. `--require-sig` + git source exits 2 with v0.5.1 deferral. Registry stays available as optional convenience for cross-org discovery + enterprise self-host (Phase 6, gated). New `docs/git-source.md`; `docs/registry.md` opens with "you might not need this."

## Open-source readiness (2026-05-19)

- `LICENSE` — MIT (since v0.1.1).
- `CONTRIBUTING.md` — present, accurate.
- `SECURITY.md` — present, points to GitHub Security Advisories.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml` — structured forms.
- `.github/PULL_REQUEST_TEMPLATE.md` — checklist with `pnpm verify` gate.
- README badge row: MIT · Node ≥22 · pnpm 9.15 · CI status.
- Repo visibility: ⚠️ **still PRIVATE as of 2026-05-19 14:00 ET.** Earlier doc copy assumed the flip had landed; it has not. The visibility change is a one-way action — flip via `gh repo edit jckeen/agent-pack --visibility public` (operator-only) when ready to announce. Until then, the `agentpack install github:jckeen/agent-pack@…` quickstart will 404 against `raw.githubusercontent.com` for anonymous fetches.

## Test status

- **484 tests passing**: 320 core + 40 cli + 19 db + 33 connector + 72 registry (iteration-9 added the signer-gate, exit-code, connector-auth, audit/CSRF, and verifyBearer-cache suites).
- All workspace packages typecheck + lint + build cleanly.
- Registry builds Next.js 15.5.18 production output: 20 dynamic + static pages, 17 API routes (one new `/admin/packs` page + one new `/api/admin/packs/[publisher]/[pack]/versions/[version]/status` POST route).
- `pnpm verify` (typecheck + lint + test + build) exit 0 on the committed tree.
- `pnpm audit --prod` — 0 critical, 0 high, 7 moderate (Next.js Image-Optimizer variants — registry stays in JSON-fallback for OSS launch; revisit when DB-backed live), 2 low.
- Iteration-5 dep bumps (2026-05-19): `next 15.1.3 → 15.5.18` (patches 2 CRITICAL + 8 HIGH per `pnpm audit`), `vitest 2.1.8 → 2.1.9` (patches 1 CRITICAL RCE).

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
- **Repo visibility flip** — operator one-time action; see "Open-source readiness" above.
- **Vercel preview deploy** — Vercel project linked; `rootDirectory` must be set to `apps/registry` in the project's Settings page in the Vercel dashboard before `vercel --prod=false` from the repo root will succeed (the CLI does not expose this setting). One-click fix; documented for the operator.
- **Phase 4 final touches** — client-side signer-identity enforcement shipped in Iteration-9 (`--expected-signer` ∪ policy `install.allowedSigners` / `requireIdentity`); admin CSRF/Origin check confirmed + tested (#16). Remaining and **gated on the live registry**: a live Sigstore round-trip from CI, and the registry serving a bound per-publisher SAN so installs auto-pin without a local allowlist.
- **Phase 6** (enterprise) — 🔒 **Gated.** Triggers on first paying-customer conversation about enterprise self-host. Schema slots preserved (`org_id` nullable, `audit_events` table exists, audit hash-chain writer landed). See `Plans/PHASE-6-GATE.md`.
- **Phase 7** (AgentPack integration) — `POST /api/v1/import/workgraph`, trust signals, Agent Commons publish bridge. Requires AgentPack registry API + Agent Commons publishing endpoint.

## Living docs

- Project ISA: `ISA.md` — 267+ ISCs total. Iterating on the project IS iterating on this file.
- Wire contract: `Plans/PROTOCOL.md`.
- Roadmap: `Plans/ROADMAP.md`.
- Phase 6 gate: `Plans/PHASE-6-GATE.md`.
- Changelog: `CHANGELOG.md`.
