# Changelog

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
