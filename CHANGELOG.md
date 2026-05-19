# Changelog

## 0.4.0-dev — 2026-05-19 (OSS launch — admin quarantine UI + community files + repo public)

**AgentPack went public today.** Repo flipped to PUBLIC at github.com/jckeen/agent-pack. Standard, registry, CLI, and adapters are all MIT-licensed; the hosted registry (when it lands at a stable URL) is a convenience, not a requirement.

**Phase 4 final UI surface — admin quarantine**

- `/admin/packs` route (auth-gated, owner-of-publisher only) — table of every pack the logged-in user owns × every version × current status, with inline quarantine (reason required, max 500 chars) and unquarantine actions. Each status change writes a hash-chained `audit_events` row capturing `actor_user_id`, `previous_status`, `new_status`, and `reason`. Phase 6 widens this to org admins; v0.4 stays owner-only.
- `POST /api/admin/packs/{publisher}/{pack}/versions/{version}/status` — session-cookie-gated (not Bearer-token; v0.4 admin is web-UI-only). Returns 401/403/404/422 as documented in the registry protocol. Block (registry-admin-only per ROADMAP D4.4) is intentionally excluded from this v0.4 surface — no registry-admin role exists yet.
- `apps/registry/lib/audit.ts` — canonical-JSON `appendAuditEvent` helper with hash chain (previous_entry_id + entry_checksum over the canonical row + previous checksum). First-row case handled. Phase 6 will introduce per-org chains; v0.4 has one chain partitioned by `org_id IS NULL`.
- `QuarantineBanner` component — replaces `InstallCommandBox` on pack detail when the active version is quarantined. Red, prominent, names the publisher/pack/version, surfaces the reason, links to the security docs.
- `apps/registry/lib/version-status.ts` — server-side helper that reads `pack_versions.status` + the latest `version_status_changed` audit event's reason payload. Returns null in JSON-fallback mode (no DB).
- 8 new vitest cases for the admin route's request schema (422 paths covered) + the audit-canonicalize stringify (deterministic key-order invariant).

**Open-source community surface**

- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1 canonical text (downloaded directly from contributor-covenant.org).
- `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml` — structured forms with surface dropdown, environment block, roadmap-phase chooser. Blank issues disabled; users routed to GitHub Security Advisories, the roadmap, and the standard spec.
- `.github/PULL_REQUEST_TEMPLATE.md` — summary/why/what-changed/testing/checklist (pnpm verify gate, new-tests gate, smoke-install gate, CHANGELOG gate).
- README rewritten — accurate phase status (1-5 shipped, 4 in dev, 6 gated), badge row (MIT/Node/pnpm/CI), 5-minute quickstart, atom-type table, repo layout, CLI reference, adapter table, security model, roadmap table, contributing pointers, project-ISA pointer.

**Pre-public audit (advisor-driven, all clean)**

- Full git history scan — `git log -p --all` regex sweep finds zero real secrets (3 placeholder matches: `user:pass@…` template strings and `postgres:dev@localhost` dev examples).
- `.env*` history — only `apps/registry/.env.example` (the expected template) was ever committed.
- `git fsck --unreachable` — no dangling commits.
- Author email enumeration — only `jckeen@gmail.com`; no internal-only address leak.
- Largest 10 git objects — top is `pnpm-lock.yaml` (183KB); no surprise binaries.
- Audit_events row records `actor_user_id` explicitly so future admin-role expansion has lineage to existing rows.

**Vercel project setup (partial)**

- `agent-pack-registry` project created under `keen-media` team, linked at repo root. `.vercel/` gitignored.
- Initial deploy fails because Vercel's `rootDirectory` setting needs to be `apps/registry` (CLI doesn't expose that field). Documented in STATUS.md; one-click dashboard fix unblocks future `vercel --prod=false` runs.

**Test status**

- 258 tests passing across 23 files (178 core + 19 db + 35 cli + 26 registry). 8 added this session.
- `pnpm verify` exit 0 on the committed tree.

---

## 0.4.0-dev / 0.3.0 — 2026-05-19 (Phase 4 cosign + production wiring + security hardening)

**AgentPack is open source.** Adding Phase 4 supply-chain trust (cosign keyless signing), wiring the registry for live Vercel + Neon + R2 deploy, and gating Phase 6 (orgs + WorkOS SSO) behind explicit demand signal in `Plans/PHASE-6-GATE.md`.

**Phase 4 — Sigstore keyless signing & verification**

- `@workgraph/core/signing` — new module wrapping `@sigstore/sign` (Fulcio CA + Rekor witness) and `@sigstore/verify`. Exposes `signManifestChecksum(opts)` and `verifyManifestSignature(opts)`. Bundle JSON is base64-encoded into the existing `lockfile.signatures.manifest` string slot (reserved in v0.2.0); no `lockfileVersion: 2` bump.
- `workgraph publish --sign` (default on when OIDC token available; `--no-sign` to opt out). Signs the manifest sha256, sends the envelope in the finalize body. Aborts before finalize if `--sign` was requested but no token is available (`SIGSTORE_ID_TOKEN` env or GitHub Actions ambient).
- `workgraph verify --sig` validates signature in addition to drift; `--strict` exits non-zero on unsigned packs. Per-roadmap exit codes: 0 ok, 2 drift, 3 chain broken, 4 signature invalid, 5 unsigned-when-required.
- Registry — new `pack_signatures` table (migration `0002_signatures.sql`), `POST /api/publish/<id>/finalize` accepts and server-verifies the signature before persisting, `GET /api/v1/packs/<pub>/<pack>/versions/<v>/signatures` exposes the proof.
- Registry UI — `SignatureBadge` component renders "Signed by @<github>" with link to the Rekor entry, or muted "Unsigned" otherwise.
- 12 new envelope-schema + identity-gate tests; live Fulcio/Rekor smoke deferred to the publish→install smoke harness.

**Security hardening — pre-Phase-4 audit findings**

Pre-Phase-4 security review flagged four issues that would have shipped to production without an audit. All four landed in this release before any signing code wrapped them:

- **C1 (critical)** — `POST /api/publish/<id>/finalize` no longer accepts arbitrary authenticated bearer tokens. The token MUST own the original publish (`pub.createdBy === verified.userId`) AND hold `publish:packs:<publisher>` scope. Removes the publisher-namespace squat vector.
- **H1 (high)** — R2 presigned PUT URLs now use S3 `ChecksumSHA256` (base64-encoded sha256 of the bytes) signed into the URL. R2 rejects the upload if the actual body hash doesn't match. The pre-fix `x-amz-meta-sha256` was an unchecked label.
- **H2 (high)** — `publishInitRequestSchema` now requires `manifestBytes` (positive integer, capped at 1 MiB). The pre-fix path presigned the manifest with `ContentLength: 0`, leaving it unbounded and unverified.
- **H3 (high)** — Per-file size cap (50 MiB), per-pack size cap (200 MiB), file-count cap (2000). Prevents resource-exhaustion via init-bomb.

Medium-severity items (in-memory device-code store, low userCode entropy, CSRF on `approve`, AUTH_SECRET soft-fail) are tracked for the next hardening pass; none block the v0.3.0 promotion since exploitation requires already holding a valid session.

**Live infra wiring**

- `apps/registry/vercel.json` — framework + region (`iad1`) + monorepo-aware install + build commands + security headers.
- `apps/registry/.env.example` — comprehensive template for `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GITHUB_ID/SECRET`, `R2_*`, `NEXT_PUBLIC_REGISTRY_URL`, optional `SIGSTORE_ID_TOKEN`.
- `scripts/bring-up-prod.sh` — guided runbook: create Vercel project under the `keen-media` team, create Neon project + DB, create Cloudflare R2 bucket + token, register a GitHub OAuth app, set every secret in Vercel, run `db:push` against live Neon, seed publishers, deploy.
- `scripts/smoke-e2e.sh` — end-to-end publish → install → verify smoke. Exercises live `/api/v1/health`, publishes a smoke version, installs into a tempdir, asserts lockfile manifestChecksum matches the registry, runs `workgraph verify` on the install. Records results to `smoke-results.json` with exit-code taxonomy (0 green, 2 registry down, 3 publish failed, 4 install failed, 5 checksum mismatch, 6 drift).
- `apps/registry/app/api/v1/health/route.ts` — probes Postgres + R2 reachability, returns `{ status, db, r2, version, duration_ms, timestamp }`; 200 ok / 503 degraded.

**Phase 6 — explicit deferral gate**

- `Plans/PHASE-6-GATE.md` — pins the trigger condition ("first paying-customer conversation about enterprise self-host"), names the 4 concrete qualifiers, lists the 8 design decisions to revisit when triggered, confirms schema slots already reserved (`org_id` nullable, `audit_events` table) stay valid through Phase 4 so the unlock is a migration not a re-architecture. Includes the gate-flip procedure for when the trigger fires.
- ROADMAP § Phase 6 prefixed with 🔒 GATED marker pointing to the gate doc.
- STATUS.md updated to reflect open-source positioning + Phase 6 gated state.

**Agent-stall investigation (PAI-internal, no AgentPack code impact)**

- Root cause identified: codex CLI's auto-prepend of `AGENTS.md`/`AGENTS.local.md` (~30 KB / ~8K tokens) accumulates across tool-call rounds, crossing the 1M-token context window on medium-sized codebases and triggering silent termination of GPT-5.4 reasoning=high.
- Investigation memo + feedback memory + doctrine-change proposal landed in `Plans/algorithm-v6.4.0-changes.md`.
- Net effect for AgentPack: every Phase 4 file in this release was written inline by the primary rather than delegated to Forge, per the new canary mandate.

**Test status**

All workspace test suites green. 250 tests passing (238 from v0.3.0-rc.1 + 12 new signing envelope tests).

**Verification pass + regression fixes (commit `014bb67`)**

End-of-session sweep against every ROADMAP gate criterion. Two regressions surfaced and fixed inline before the session closed:

- `workgraph install examples/pr-quality` (local path with a slash) matched the Phase 5 `REMOTE_ID_RE` and fell through to the remote fetcher, returning "fetch failed" against the default registry. Fix: stat the path first; if it's a directory, prefer local. Remote-id still wins when there's no matching directory.
- `apps/registry/tests/protocol-schemas.test.ts` was missing `manifestBytes` in the well-formed body fixture after the H2 schema tightening, leaving 1 registry test red. Updated.

Verification matrix shipped offline-green for Phases 1-6: doctor/validate/inspect/plan/init/pack-export×5; install/verify-clean/drift→exit-2/diff/history/uninstall-conflict/uninstall--force; registry JSON-fallback boot (`/`, `/packs`, `/packs/<pub>/<slug>` all 200; `/api/v1/health` 503-degraded shape correct; `/api/v1/.../signatures` 503 db_unconfigured); Phase 4 envelope tests + CLI flag surfaces + `verify --sig --strict` → exit 5 + `install --require-sig` local → exit 2 + "Unsigned" badge rendered in HTML; cache + login/whoami/tokens subcommands; Phase 6 gate doc verified. Live deploy + live Sigstore round-trip remain the only deferred gates — both blocked on user-supplied credentials.

## 0.3.0-rc.1 — 2026-05-18 (Phase 3 + Phase 5 scaffold)

End-to-end supply chain skeleton: publish → fetch → install → verify all wired in code. Real Neon DB, GitHub OAuth, and R2 bucket plug in via env vars; the build, tests, and typecheck run cleanly without them. 117 new ISCs (ISC-151..267).

**`@workgraph/db` — new workspace package**

- Drizzle schema for 13 registry tables + 3 Auth.js adapter tables matching `Plans/PROTOCOL.md` § 4 verbatim: `users`, `publishers`, `publisher_members`, `packs` (with `tsvector` generated FTS column + GIN index), `pack_versions`, `atoms`, `pack_files`, `compatibilities`, `api_tokens`, `publishes`, `reviews`, `audit_events` (Phase 6 reserved), `accounts`, `sessions`, `verification_tokens`.
- Query helpers for packs, publishers, tokens, publishes. Drizzle ORM + `postgres` driver + `@neondatabase/serverless`.
- Hand-written `migrations/0000_init.sql` covers every table, FK, unique constraint, GIN index, and the `pack_version_status` enum.
- 19 unit tests (type-inference + query-signature smoke).

**Protocol commit (`packages/core/src/protocol/`)**

- Zod schemas pinning every wire shape: `PublishInitRequest/Response`, `PublishFinalizeRequest/Response`, `RegistryPack`, `RegistryVersion`, error envelopes, `cliAuthInit/Poll`, primitives (`slug`, `semver`, `sha256Hex`, relative path), token format (`wgp_live_` + 32-hex), token scopes, `DEFAULT_REGISTRY_URL`.
- `ExitCode` enum (0/1/2/3/4/5/6/7/9) + `errorNameToExitCode` mapper.

**`packages/core/src/registry-client/`**

- `RegistryClient` interface with `listVersions`, `getVersion`, `fetchManifest`, `fetchAtomFile` (sha256-verifying — mismatch → `IntegrityError` → exit 7).
- `HttpRegistryClient` against the Phase 3 API. Sends `Authorization: Bearer` when token present.
- `InMemoryRegistryClient` fixture for tests.
- `resolveLatestVersion` picks highest non-prerelease semver, returns null if list empty or all prerelease.
- 16 tests.

**`packages/core/src/cache/`**

- Content-addressed blob store at `~/.workgraph/cache/blobs/<sha[0..2]>/<sha>`.
- `writeBlob` verifies `sha256(bytes) === sha` before atomic rename; mismatch → `IntegrityError`. `fetchAndCache` integrates the integrity check with HTTP fetch.
- `cacheSize`, `cachePrune({ maxAgeMs })`, `cacheClear` — every candidate path's realpath must be inside `<blobs>` (anti-criterion ISC-246).
- 13 tests.

**`packages/core/src/policy/`**

- Zod schema for `workgraph.policy.json` v1 per protocol § 7.
- `loadPolicy(projectRoot)` returns config or null. Invalid JSON / schema → `PolicyParseError`.
- `enforcePolicy(policy, plan, registryUrl)` reports all violations at once (registry → publisher → blockedPack → unsigned → profile → atomType). Empty plan → `{ ok: true }`. Violations → exit 6 via the CLI.
- 12 tests.

**`apps/registry` (Next.js 15 App Router)**

- `lib/{db,auth,tokens,r2}.ts` — DB client (re-exports `@workgraph/db` schema), NextAuth v5 + Drizzle adapter with GitHub OAuth, token mint/verify (sha256 storage + scope check, fire-and-forget `last_used_at`), R2 client + presigner + HEAD + stream.
- API routes:
  - `/api/auth/[...nextauth]` — NextAuth handler.
  - `/api/tokens` GET/POST, `/api/tokens/[id]` DELETE — list, mint, revoke.
  - `/api/cli/auth/init|approve|poll` — device-code flow for `workgraph login`.
  - `/api/me` — bearer-authed user info.
  - `/api/publish/init`, `/api/publish/[publishId]/finalize` — two-phase publish with presigned R2 PUT URLs and HEAD-only size verification at finalize.
  - `/api/packs`, `/api/packs/[publisher]/[pack]`, `.../versions/[version]`, `.../manifest.yaml`, `.../atoms/[atomId]/[...path]` — read API with R2-streamed bytes, immutable cache headers, 451-on-quarantined.
  - `/api/search` — Postgres FTS via `plainto_tsquery` + `ts_rank_cd`.
  - `/api/packs/.../reviews` — GET returns seed reviews; POST returns 501 (per ROADMAP D3.7).
- `/(authed)/tokens/page.tsx` — user token management UI.
- `lib/cli-auth-store.ts` — in-memory device-code store (15-min TTL).
- Graceful cascade: every route returns 503 (`db_unconfigured` / `r2_unconfigured`) when env vars are missing.
- 18 tests (protocol schemas + token primitives).

**`packages/cli` — 5 new commands + remote install branch**

- `workgraph login` — device-code OAuth against the registry. Writes `~/.workgraph/credentials.json` with mode `0o600`. Token display always masked (`wgp_live_xxxx…<last-4>`).
- `workgraph whoami` — bearer-authed `/api/me` read.
- `workgraph tokens list|create|revoke` — manage API tokens.
- `workgraph publish` — load manifest, compute per-file sha256, two-phase publish (`init` → PUT each presigned URL → `finalize`). Handles 401/403/409/422/410 with the right exit code.
- `workgraph cache size|prune|clear` — manage the local blob cache.
- `workgraph install <publisher>/<pack>[@version] --registry <url>` — remote-resolver branch in `install.ts`: identity regex match → `HttpRegistryClient` → `resolveLatestVersion` (if no `@version`) → fetch + verify + cache → materialize temp dir → hand off to existing Phase 2 `planInstall`/`applyInstall`. `loadPolicy` + `enforcePolicy` run pre-install; violation → exit 6.
- `packages/cli/src/lib/credentials.ts` — `~/.workgraph/credentials.json` read/write/clear with `0o600` perms, atomic write, `WORKGRAPH_TOKEN` env override.
- 8 new credentials tests.

**Docs**

- `docs/registry.md` — architecture, schema, auth, publish flow, search, reviews-deferred, storage, local-dev.
- `docs/publish.md` — `workgraph publish` reference, token model, CI publishing recipe.
- `docs/remote-install.md` — identity grammar, fetch pipeline, cache, policy hooks, exit codes.
- `docs/policy.md` — `workgraph.policy.json` schema, enforcement order, examples.

**Protocol**

- `Plans/PROTOCOL.md` — pinned token format (`wgp_live_` + 32-hex + sha256 storage + scopes), publish trust model (HEAD-only at finalize; full re-hash deferred to Phase 4), wire shapes, DB column names, exit codes, cache layout, policy schema, NextAuth config, pinned deps.

**Deps added**

- Root: `drizzle-kit@0.31.10`, `tsx@4.19.2` (devDeps); `seed:import`, `db:push`, `db:generate` scripts.
- `packages/db`: `drizzle-orm@0.45.2`, `postgres@3.4.9`, `@neondatabase/serverless@1.1.0`.
- `apps/registry`: `next-auth@5.0.0-beta.31`, `@auth/drizzle-adapter@1.11.2`, `@aws-sdk/client-s3@3.1049.0`, `@aws-sdk/s3-request-presigner@3.1049.0`, `drizzle-orm@0.45.2`, `postgres@3.4.9`, `@neondatabase/serverless@1.1.0`, `@workgraph/db@workspace:*`. Test stack: `vitest@2.1.8` + `@vitest/coverage-v8@2.1.8`.

**Test totals**

- **238 tests passing** (up from 172 pre-iteration): 19 db + 166 core + 18 registry + 35 cli.
- All packages typecheck and build cleanly without DATABASE_URL / R2 / GitHub OAuth env vars.

**What's deferred to dedicated sessions**

- **Phase 4** — Sigstore cosign keyless signing, `workgraph verify --sig`, quarantine UI. Lockfile slots already reserved.
- **Phase 6** — Orgs, WorkOS SSO, audit-events chain wiring, policy-as-code overlay. Schema rows reserved.
- **Phase 7** — Workgraph workflow import, trust signal aggregation, Agent Commons bridge.

## 0.2.0 — 2026-05-18 (Phase 2 — local install / uninstall / verify)

Phase 2 of the implementation plan: extend the standard from "compile to native files" to "install into a project root with full provenance, drift detection, and reversibility." 74 new ISCs land (ISC-69..ISC-142, plus ISC-143..ISC-150 from the advisor-driven WAL pass).

**Core engine (`@workgraph/core/install/`)**

- `planInstall()` — classifies every target path against the user's project: `created` / `modified` / `unchanged` / `conflict` (no-marker-existing-content or other-pack-marker). Computes the lockfile inline.
- `applyInstall()` — write-ahead log to `.workgraph/history.jsonl`: append `install_begin` (with `plannedFiles[]` + SHA-256), backup overwritten files to `.workgraph/backups/<pack>/<ts>.<nonce>/`, atomic write of every adapter file (tmp + rename), write `AGENTPACK.lock` at project root, write install manifest at `.workgraph/installed/<pack>.json`, append `install_commit`.
- `uninstall()` — read install manifest, restore backups, delete created files, prune empty parent dirs, delete manifest, append `uninstall` history entry. Refuses without `--force` when user has edited a tracked file since install.
- `verifyInstall()` — recompute SHA-256 of every tracked file vs. the install manifest's recorded hash. Reports `drift[]` / `missing[]`. `--chain` also verifies the history hash chain.
- `rollback()` — undo the most recent install, or with `--to <historyId>`, undo everything after that entry. Refuses superseded installs without `--cascade`.
- `recoverIncomplete()` — sweep for dangling `install_begin` entries on every install. Roll forward (write missing commit) when staged files match the planned SHA-256s, roll back (delete partial files) otherwise.

**Lockfile (`AGENTPACK.lock`, deterministic, committed)**

- Per-atom + per-file SHA-256 — per-file granularity is the unlock primitive for Phase 4 signature verification (cosign signs file digests, not logical atoms).
- `manifestChecksum`: SHA-256 of the raw `AGENTPACK.yaml` bytes (not parsed-then-stringified).
- `canonicalization: { algorithm, encoding, lineEndings }` pinned explicitly.
- `signatures` / `dependencies` reserved (empty in Phase 2) to avoid a v2 bump when Phase 3/4 land.
- **No `installedAt` field** — timestamps would break determinism. Two clean installs at the same version produce byte-identical lockfiles.

**History (`.workgraph/history.jsonl`, append-only, hash-chained)**

- ULID-style monotonic `id`, `previousEntryId` + `entryChecksum` form a hash chain.
- `entryChecksum = sha256(canonicalJson(entry minus entryChecksum))` — canonical JSON with recursively-sorted keys.
- mtime-based file lock around every append (single-writer guarantee under concurrent CLI invocations).
- WAL semantics: `install_begin` (with `plannedFiles[]`) before any file write; `install_commit` last; absence of commit is the crash signal.
- Rotation NOT supported in Phase 2 — file grows monotonically (documented in `docs/install.md`).

**CLI (six new subcommands)**

- `workgraph install <pack> --target X --profile Y --project <dir>` — diff + prompt + write. `--dry-run`, `--yes`, `--force`.
- `workgraph uninstall <packId>` — `--yes`, `--force`, `--force-restore`.
- `workgraph diff <pack>` — unified diff between current project and install plan.
- `workgraph history` — list, `--pack`, `--limit`, `--json`.
- `workgraph rollback [historyId]` — `--to`, `--pack`, `--cascade`, `--yes`.
- `workgraph verify <packId>` — drift report. `--chain` validates hash chain. Exit codes: 0 clean, 2 drift, 3 chain broken.

**Registry web app**

- `InstallCommandBox` surfaces `install`, `pack export`, `verify`, and `validate` with explanatory copy.
- `/docs` documents Phase 2 install / uninstall / verify / rollback surface.

**Docs**

- New `docs/install.md` — full reference for the Phase 2 surface.
- README quickstart includes install/verify/uninstall/rollback/history examples.

**Tests**

- 48 new tests (39 core + 9 CLI) across 7 new files. **Total: 172 tests passing.**
- Core coverage: 88.32% lines / 76.04% branches / 96.39% functions / 88.32% statements (thresholds met).

## 0.1.1 — 2026-05-18 (hardening pass)

Multi-agent security review (security-reviewer, Silas, code-reviewer, silent-failure-hunter, type-design-analyzer) closed four critical attack chains and seven high/medium findings against the v0.1 MVP.

**Security**

- `atom.path` traversal closed: schema rejects absolute paths, `..` segments, and `~/` home expansion. I/O layer enforces realpath containment and refuses symlinks at the atom path. Closes Silas Chain 1.
- Hook `handler.command` injection closed: hook commands MUST appear in `permissions.shell.commands`; shell escape patterns (`sh -c`, `bash -c`, `node -e`, eval) refused outright. Closes Silas Chain 2.
- MCP shell escape closed: `mcp_server` invoking `sh|bash|node|python` with `-c`/`-e`/`--eval` raised to critical risk. Closes Silas Chain 5.
- Risk-engine under-reporting closed: `hook` and `mcp_server` atoms floor at `high` regardless of declared `risk_level`. Audit-trail records every atom + permission (not just deltas). Closes Silas Chain 4.
- Prototype-pollution-safe stable JSON serialization (drops `__proto__`, `constructor`, `prototype` keys).
- Manifest size cap: 1 MiB on disk, 256 KiB through the registry `/validate` server action.
- TOML escape now covers `\n`, `\r`, `\t`, and C0/C1 control characters.

**Correctness**

- `summarizePermissions` surfaces previously-dropped `user_data_access` and `private_context_access` pack-level flags.
- `exportPack` strict mode refuses to ship degenerate output when atom body files are missing (new `--allow-missing` opt-in).
- Profile resolution refuses silent fallback to `safe`; the planner errors when no profile is declared.
- `extractFieldFromYaml` regex extractor replaced with the real `yaml` parser inside the Claude Code adapter.
- ChatGPT adapter splits identifier-safe slug (binding names) from filesystem-safe slug (import paths).
- CLI `validate` / `inspect` / `plan` wrap their action bodies in `try/catch` and render polished error output instead of Node stack traces.
- Validator: case-insensitive duplicate-atom-id detection; unknown permission categories warn; `exports.default_profile` is checked against declared profiles.

**Tooling**

- 58 new tests (22 security + 18 coverage-fill + 18 CLI) for **85 total**.
- vitest coverage thresholds: 85% lines/functions/statements, 75% branches. Current: 90.5% / 98.3% / 90.5% / 77.1%.
- ESLint flat config (typescript-eslint), Prettier config, root `pnpm verify` script.
- `.github/workflows/ci.yml` running typecheck/lint/test/build + a CLI smoke export.
- `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`.

## 0.1.0 — 2026-05-18

Initial MVP build of the AgentPack standard + Workgraph Registry monorepo.

- `@workgraph/core`: zod-backed schema, parser, validator, permission summary engine, risk engine, planner, install-plan builder, exportPack convenience entry, and seed-pack module.
- Five adapters: `claude-code`, `codex`, `cursor`, `chatgpt` (export-only), `generic`. Deterministic output, BEGIN/END markers in instruction files.
- `@workgraph/cli`: `init`, `validate`, `inspect`, `plan`, `pack export`, `doctor` (commander + picocolors + ora + diff).
- `@workgraph/registry`: Next.js App Router app with `/`, `/packs`, `/packs/[publisher]/[slug]`, `/validate`, `/docs`. Eight local components, Tailwind, seed data, server actions for validation.
- Example pack `examples/pr-quality` exercises every atom type and compiles to all five targets.
- 27 vitest tests across manifest, risk, and adapter coverage.
- README, `docs/agentpack-standard.md`, `docs/security.md`, `docs/adapters.md`, `docs/cli.md`.
- Project ISA at `ISA.md` — 68 testable ISCs covering build, schema, permissions, risk, CLI, adapters, registry, docs, and anti-criteria.
