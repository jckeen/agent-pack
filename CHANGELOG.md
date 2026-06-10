# Changelog

## 0.5.1-dev — 2026-06-10 (consent permission summary + adapter readback + cleanup)

Audit-driven fix batch. No new commands — closes the gap between what `plan` shows and what `install` asks consent for, plus two assurance/cleanup items.

**Install consent — permission summary now shown before the y/N prompt**

- **`agentpack install` previously asked for consent without ever showing the permission surface.** The plan summary printed only the pack-level risk badge and the file Create/Modify/Unchanged/Conflict lists — a user who ran `install` without first running `plan` consented to shell commands, secrets, and network domains they never saw. The full risk-grouped permission summary (per-atom attribution, required secrets, network domains, declared shell commands) is now rendered under a `Permissions:` header before the confirm prompt, and in `--dry-run` output. (`packages/cli/src/commands/install.ts`, reusing `renderPermissionSummary` from `packages/cli/src/lib/render.ts`)
- 2 new CLI assertions + 1 new CLI test (`plan summary shows the full permission surface before consent`) in `packages/cli/tests/install.cli.test.ts` — full-profile dry-run must surface `HIGH RISK`, `GITHUB_TOKEN`, `api.github.com`, and `npm run format`.

**Adapter hygiene**

- **Removed a stray NUL byte from `packages/core/src/adapters/codex.ts`** (line 23, the `tomlEscape` control-character regex used raw `\x00`–`\x1f`/`\x7f` literals, making every grep treat the file as binary). Rewritten as `\u0000-\u001f\u007f` escapes — identical behavior, file is plain text again.
- **2 new semantic readback tests in `packages/core/tests/adapters.test.ts`** — exports the pr-quality pack (full profile) and parses the emitted config back: `.claude/settings.json` via `JSON.parse` and `.codex/config.toml` via a minimal table parser, asserting the github MCP server's `command`/`args`/`env` survive the round-trip intact (previous tests only checked file existence and byte determinism).
- **Codex adapter now emits `env_vars` instead of the made-up `env_required` key** (Codex review P2). Per the Codex config reference, `mcp_servers.<id>.env_vars` is the documented key for "environment variables to allow and forward" to a stdio server — exactly AgentPack's semantics (we know the required variable _names_; the values are user-held secrets). The previous `env_required` key was not part of Codex's config schema, so env forwarding was silently absent from generated `.codex/config.toml`. We deliberately do NOT emit a literal `env = { VAR = "${VAR}" }` map: Codex performs no `${VAR}` interpolation in `env` values, so that would forward broken placeholder strings. (`packages/core/src/adapters/codex.ts`)

**Documentation**

- `docs/install.md` — new "Upgrading: re-install IS the upgrade path" section. There is intentionally no `upgrade` command: installing a newer version over an existing install carries ownership and backups across (apply step + install manifest), with `verify`/`history` covering status. Rollback semantics stated precisely (Codex review P2, verified by live probe): rolling back an upgrade runs a full `uninstall` of the latest install — it deletes everything the new manifest owns (including byte-identical carried-over files), restores overwritten files to pre-upgrade content from backup, and removes the manifest; it does **not** restore the previous version as an installed pack. Re-installing the older version is the way back (probe: re-install after rollback → `verify` clean). Also documents that upgrades touching marker-less files (e.g. `agentpack.json`) classify as conflicts and need `--force`.

---

## 0.5.0-dev — 2026-05-19 (iteration-5 launch-readiness pass)

Pre-launch verification session. No new product surface — this iteration audits, patches, and tightens the existing v0.5 codebase so the public launch starts from a known-clean state.

**Security**

- `next 15.1.3 → 15.5.18` — patches 2 CRITICAL CVEs (Middleware Auth Bypass GHSA-f82v-jwr5-mffw, RCE in React flight protocol GHSA-3h52-269p-cp9r) + 8 HIGH (DoS, SSRF, request smuggling).
- `vitest 2.1.8 → 2.1.9` and `@vitest/coverage-v8 2.1.8 → 2.1.9` — patches 1 CRITICAL (CVE-2025-24964, dev-server RCE via malicious site).
- `pnpm audit --prod` now reports 0 critical / 0 high / 7 moderate (Next.js Image-Optimizer variants — registry stays in JSON-fallback for OSS launch) / 2 low.

**Install engine — bug fixes**

- **`agentpack install --force` over an existing install no longer orphans unchanged files on uninstall.** Reproducer: `install` → tamper one file → `install --force` → `uninstall` previously left bit-identical files on disk because the new manifest's `created[]` only tracked the file that actually differed. Fix records `plan.unchanged[]` paths in `created[]` so uninstall takes full ownership. (`packages/core/src/install/apply.ts`)
- **Atom-id missing the `:` separator now produces a friendly zod error instead of a `"Cannot read properties of undefined (reading 'split')"` runtime panic.** Reproducer: `id: "no-colon-here"` in `AGENTPACK.yaml`. (`packages/core/src/schema/agentpack.schema.ts`)

**Documentation**

- `CONTRIBUTING.md` — rewritten to reflect actual v0.5 state (was stuck at v0.1 / 67 tests / "no npm artifact yet"). Documents `pnpm verify`, the 5-package layout, and the per-add-a-target / per-add-a-command checklist.
- `docs/cli.md` — rewritten to cover all 19 commands (was Phase-1 era — missing `install`, `verify`, `rollback`, `diff`, `history`, `uninstall`, `login`, `publish`, `tokens`, `cache`, plus `--sig`/`--strict`/`--require-sig` flags). Exit codes now match the ROADMAP taxonomy.
- `docs/security.md` — removed stale "MVP does not yet install into a project root" claim (Phase 2 shipped install in v0.2.0).
- `docs/signatures.md` and `apps/registry/.env.example` — registry URL standardized to `registry.agentpack.dev` (was inconsistent — `agentpack.dev` in some examples).
- `docs/registry.md` — fixed inline-link text mismatch.
- `README.md` — quickstart now leads with the clone+build path (since `agentpack` isn't on npm yet); status banner clarifies that the hosted registry is not yet live; CTA added.
- `STATUS.md` — surfaces the still-private repo state honestly; removed internal-only operator details (Vercel team slug, Algorithm doctrine pointer).

**Live verification**

- Probed `install → verify → drift-detect → restore → uninstall` round-trip on a fresh tmpdir, claude-code/safe profile. All 4 files written, drift detected on tamper, force-restore clean, uninstall removed all 4 + restored backups. (Iteration-5 ISCs in `ISA.md`.)
- All 5 adapter targets (`claude-code`, `codex`, `cursor`, `chatgpt`, `generic`) export cleanly; determinism confirmed (two runs → byte-identical files).
- `pnpm verify` (typecheck + lint + test + build) exit 0 with the dep bumps + bug fixes applied.

**Surfaced for operator decision (not auto-applied)**

- **Repo visibility flip from PRIVATE → PUBLIC** — earlier doc copy claimed this had landed on 2026-05-19; it hasn't. One-way action, operator must run `gh repo edit jckeen/agent-pack --visibility public` when ready. Until then, the git-source quickstart `agentpack install github:jckeen/agent-pack@…` returns 404.
- **Outstanding security findings** (audited by `security-reviewer` 2026-05-19): Sigstore identity-mismatch enforcement currently optional (caller must pass `expectedSAN`); audit-events race on concurrent writes; missing CSRF/Origin check on `/api/admin/.../status`; `parseGitId` accepts refs with control characters; `fetchGitPack` doesn't pin SHAs for branch refs. None are runtime-critical for OSS launch (registry isn't live); all queued for v0.5.1 hardening.
- **Outstanding bugs from QA pass** (audited by `qa-lead` 2026-05-19): concurrent `agentpack install` race against the same project root; non-typed exit codes for `uninstall not-found` etc.; Windows-reserved-name validation in atom paths. Queued for v0.5.1.

---

## 0.5.0-dev — 2026-05-19 (git-source install — registry becomes optional)

AgentPack's primary install path is now **git**. `agentpack install github:owner/repo@ref[#subpath]` works without any hosted registry. The hosted registry stays available as an optional convenience for cross-org discovery, schema-validated metadata at index time, admin-side quarantine, and the enterprise self-host path (Phase 6 — still gated). For everyday OSS publishing, the leaner path is now the default.

**New surfaces**

- `@agentpack/core/git-source` — `parseGitId(input)` returns a structured `GitSource` for `github:owner/repo[@ref][#subpath]` and `github.com/owner/repo[@ref][#subpath]`; `fetchGitPack({ source })` materializes a tmpRoot via `raw.githubusercontent.com` per-file fetch and returns the path. Same contract as `fetchRemotePack` — feeds into the existing `planInstall` pipeline. Trailing `.git` tolerated; branch refs with slashes supported; default-branch resolution via GitHub API when `@ref` omitted.
- CLI `install` command — new source-detection order: local path → git source → registry id. Local always wins; git prefix (`github:` or `github.com/`) wins over registry-id format because git has an unambiguous prefix. No registry-id behavior changes.
- 11 new vitest cases in `packages/core/tests/git-source.test.ts` — 8 `parseGitId` table cases (happy + ref-with-slash + `.git` strip + null returns) + 3 `fetchGitPack` mocked-fetch cases (happy roundtrip + path-traversal rejection + 404 surfacing).
- New `docs/git-source.md` — full syntax + examples + signature notes + comparison-vs-registry table.
- `docs/registry.md` opens with a "you might not need this" preamble pointing readers at the git path; the rest of the engineering reference is unchanged.
- README quickstart rewritten — leads with `agentpack install github:jckeen/agent-pack@master#examples/pr-quality`; "Hosted registry (optional)" is a smaller subsection at the bottom.

**Deferred to v0.5.1**

- Git-source signature verification (`agentpack install github:... --require-sig`). Today the CLI exits 2 with a clear "cosign-on-tag arrives in v0.5.1" message. Phase 4 cosign signs registry-published manifests; extending it to git tags is on the roadmap.
- Non-GitHub git hosts (`gitlab:`, `bitbucket:`, generic `git+https://...`). Parser is host-aware and extends cleanly when there's demand.
- Tarball-based fetch (one HTTP request, one extraction). Current per-file fetch is fine for typical packs (10-20 files) and avoids a `tar` dependency.

**Test status**

- 269 tests passing across 24 files (189 core + 19 db + 35 cli + 26 registry). 11 added this session.
- `pnpm verify` exit 0; no new npm deps; existing 258 tests all green.

---

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

## 0.4.0-dev / 0.3.0 (pre-public) — 2026-05-19 (Phase 4 cosign + production wiring + security hardening)

**AgentPack is open source.** Adding Phase 4 supply-chain trust (cosign keyless signing), wiring the registry for live Vercel + Neon + R2 deploy, and gating Phase 6 (orgs + WorkOS SSO) behind explicit demand signal in `Plans/PHASE-6-GATE.md`.

**Phase 4 — Sigstore keyless signing & verification**

- `@agentpack/core/signing` — new module wrapping `@sigstore/sign` (Fulcio CA + Rekor witness) and `@sigstore/verify`. Exposes `signManifestChecksum(opts)` and `verifyManifestSignature(opts)`. Bundle JSON is base64-encoded into the existing `lockfile.signatures.manifest` string slot (reserved in v0.2.0); no `lockfileVersion: 2` bump.
- `agentpack publish --sign` (default on when OIDC token available; `--no-sign` to opt out). Signs the manifest sha256, sends the envelope in the finalize body. Aborts before finalize if `--sign` was requested but no token is available (`SIGSTORE_ID_TOKEN` env or GitHub Actions ambient).
- `agentpack verify --sig` validates signature in addition to drift; `--strict` exits non-zero on unsigned packs. Per-roadmap exit codes: 0 ok, 2 drift, 3 chain broken, 4 signature invalid, 5 unsigned-when-required.
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
- `scripts/smoke-e2e.sh` — end-to-end publish → install → verify smoke. Exercises live `/api/v1/health`, publishes a smoke version, installs into a tempdir, asserts lockfile manifestChecksum matches the registry, runs `agentpack verify` on the install. Records results to `smoke-results.json` with exit-code taxonomy (0 green, 2 registry down, 3 publish failed, 4 install failed, 5 checksum mismatch, 6 drift).
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

- `agentpack install examples/pr-quality` (local path with a slash) matched the Phase 5 `REMOTE_ID_RE` and fell through to the remote fetcher, returning "fetch failed" against the default registry. Fix: stat the path first; if it's a directory, prefer local. Remote-id still wins when there's no matching directory.
- `apps/registry/tests/protocol-schemas.test.ts` was missing `manifestBytes` in the well-formed body fixture after the H2 schema tightening, leaving 1 registry test red. Updated.

Verification matrix shipped offline-green for Phases 1-6: doctor/validate/inspect/plan/init/pack-export×5; install/verify-clean/drift→exit-2/diff/history/uninstall-conflict/uninstall--force; registry JSON-fallback boot (`/`, `/packs`, `/packs/<pub>/<slug>` all 200; `/api/v1/health` 503-degraded shape correct; `/api/v1/.../signatures` 503 db_unconfigured); Phase 4 envelope tests + CLI flag surfaces + `verify --sig --strict` → exit 5 + `install --require-sig` local → exit 2 + "Unsigned" badge rendered in HTML; cache + login/whoami/tokens subcommands; Phase 6 gate doc verified. Live deploy + live Sigstore round-trip remain the only deferred gates — both blocked on user-supplied credentials.

## 0.3.0-rc.1 — 2026-05-18 (Phase 3 + Phase 5 scaffold)

End-to-end supply chain skeleton: publish → fetch → install → verify all wired in code. Real Neon DB, GitHub OAuth, and R2 bucket plug in via env vars; the build, tests, and typecheck run cleanly without them. 117 new ISCs (ISC-151..267).

**`@agentpack/db` — new workspace package**

- Drizzle schema for 13 registry tables + 3 Auth.js adapter tables matching `Plans/PROTOCOL.md` § 4 verbatim: `users`, `publishers`, `publisher_members`, `packs` (with `tsvector` generated FTS column + GIN index), `pack_versions`, `atoms`, `pack_files`, `compatibilities`, `api_tokens`, `publishes`, `reviews`, `audit_events` (Phase 6 reserved), `accounts`, `sessions`, `verification_tokens`.
- Query helpers for packs, publishers, tokens, publishes. Drizzle ORM + `postgres` driver + `@neondatabase/serverless`.
- Hand-written `migrations/0000_init.sql` covers every table, FK, unique constraint, GIN index, and the `pack_version_status` enum.
- 19 unit tests (type-inference + query-signature smoke).

**Protocol commit (`packages/core/src/protocol/`)**

- Zod schemas pinning every wire shape: `PublishInitRequest/Response`, `PublishFinalizeRequest/Response`, `RegistryPack`, `RegistryVersion`, error envelopes, `cliAuthInit/Poll`, primitives (`slug`, `semver`, `sha256Hex`, relative path), token format (`agp_live_` + 32-hex), token scopes, `DEFAULT_REGISTRY_URL`.
- `ExitCode` enum (0/1/2/3/4/5/6/7/9) + `errorNameToExitCode` mapper.

**`packages/core/src/registry-client/`**

- `RegistryClient` interface with `listVersions`, `getVersion`, `fetchManifest`, `fetchAtomFile` (sha256-verifying — mismatch → `IntegrityError` → exit 7).
- `HttpRegistryClient` against the Phase 3 API. Sends `Authorization: Bearer` when token present.
- `InMemoryRegistryClient` fixture for tests.
- `resolveLatestVersion` picks highest non-prerelease semver, returns null if list empty or all prerelease.
- 16 tests.

**`packages/core/src/cache/`**

- Content-addressed blob store at `~/.agentpack/cache/blobs/<sha[0..2]>/<sha>`.
- `writeBlob` verifies `sha256(bytes) === sha` before atomic rename; mismatch → `IntegrityError`. `fetchAndCache` integrates the integrity check with HTTP fetch.
- `cacheSize`, `cachePrune({ maxAgeMs })`, `cacheClear` — every candidate path's realpath must be inside `<blobs>` (anti-criterion ISC-246).
- 13 tests.

**`packages/core/src/policy/`**

- Zod schema for `agentpack.policy.json` v1 per protocol § 7.
- `loadPolicy(projectRoot)` returns config or null. Invalid JSON / schema → `PolicyParseError`.
- `enforcePolicy(policy, plan, registryUrl)` reports all violations at once (registry → publisher → blockedPack → unsigned → profile → atomType). Empty plan → `{ ok: true }`. Violations → exit 6 via the CLI.
- 12 tests.

**`apps/registry` (Next.js 15 App Router)**

- `lib/{db,auth,tokens,r2}.ts` — DB client (re-exports `@agentpack/db` schema), NextAuth v5 + Drizzle adapter with GitHub OAuth, token mint/verify (sha256 storage + scope check, fire-and-forget `last_used_at`), R2 client + presigner + HEAD + stream.
- API routes:
  - `/api/auth/[...nextauth]` — NextAuth handler.
  - `/api/tokens` GET/POST, `/api/tokens/[id]` DELETE — list, mint, revoke.
  - `/api/cli/auth/init|approve|poll` — device-code flow for `agentpack login`.
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

- `agentpack login` — device-code OAuth against the registry. Writes `~/.agentpack/credentials.json` with mode `0o600`. Token display always masked (`agp_live_xxxx…<last-4>`).
- `agentpack whoami` — bearer-authed `/api/me` read.
- `agentpack tokens list|create|revoke` — manage API tokens.
- `agentpack publish` — load manifest, compute per-file sha256, two-phase publish (`init` → PUT each presigned URL → `finalize`). Handles 401/403/409/422/410 with the right exit code.
- `agentpack cache size|prune|clear` — manage the local blob cache.
- `agentpack install <publisher>/<pack>[@version] --registry <url>` — remote-resolver branch in `install.ts`: identity regex match → `HttpRegistryClient` → `resolveLatestVersion` (if no `@version`) → fetch + verify + cache → materialize temp dir → hand off to existing Phase 2 `planInstall`/`applyInstall`. `loadPolicy` + `enforcePolicy` run pre-install; violation → exit 6.
- `packages/cli/src/lib/credentials.ts` — `~/.agentpack/credentials.json` read/write/clear with `0o600` perms, atomic write, `AGENTPACK_TOKEN` env override.
- 8 new credentials tests.

**Docs**

- `docs/registry.md` — architecture, schema, auth, publish flow, search, reviews-deferred, storage, local-dev.
- `docs/publish.md` — `agentpack publish` reference, token model, CI publishing recipe.
- `docs/remote-install.md` — identity grammar, fetch pipeline, cache, policy hooks, exit codes.
- `docs/policy.md` — `agentpack.policy.json` schema, enforcement order, examples.

**Protocol**

- `Plans/PROTOCOL.md` — pinned token format (`agp_live_` + 32-hex + sha256 storage + scopes), publish trust model (HEAD-only at finalize; full re-hash deferred to Phase 4), wire shapes, DB column names, exit codes, cache layout, policy schema, NextAuth config, pinned deps.

**Deps added**

- Root: `drizzle-kit@0.31.10`, `tsx@4.19.2` (devDeps); `seed:import`, `db:push`, `db:generate` scripts.
- `packages/db`: `drizzle-orm@0.45.2`, `postgres@3.4.9`, `@neondatabase/serverless@1.1.0`.
- `apps/registry`: `next-auth@5.0.0-beta.31`, `@auth/drizzle-adapter@1.11.2`, `@aws-sdk/client-s3@3.1049.0`, `@aws-sdk/s3-request-presigner@3.1049.0`, `drizzle-orm@0.45.2`, `postgres@3.4.9`, `@neondatabase/serverless@1.1.0`, `@agentpack/db@workspace:*`. Test stack: `vitest@2.1.8` + `@vitest/coverage-v8@2.1.8`.

**Test totals**

- **238 tests passing** (up from 172 pre-iteration): 19 db + 166 core + 18 registry + 35 cli.
- All packages typecheck and build cleanly without DATABASE_URL / R2 / GitHub OAuth env vars.

**What's deferred to dedicated sessions**

- **Phase 4** — Sigstore cosign keyless signing, `agentpack verify --sig`, quarantine UI. Lockfile slots already reserved.
- **Phase 6** — Orgs, WorkOS SSO, audit-events chain wiring, policy-as-code overlay. Schema rows reserved.
- **Phase 7** — AgentPack workflow import, trust signal aggregation, Agent Commons bridge.

## 0.2.0 — 2026-05-18 (Phase 2 — local install / uninstall / verify)

Phase 2 of the implementation plan: extend the standard from "compile to native files" to "install into a project root with full provenance, drift detection, and reversibility." 74 new ISCs land (ISC-69..ISC-142, plus ISC-143..ISC-150 from the advisor-driven WAL pass).

**Core engine (`@agentpack/core/install/`)**

- `planInstall()` — classifies every target path against the user's project: `created` / `modified` / `unchanged` / `conflict` (no-marker-existing-content or other-pack-marker). Computes the lockfile inline.
- `applyInstall()` — write-ahead log to `.agentpack/history.jsonl`: append `install_begin` (with `plannedFiles[]` + SHA-256), backup overwritten files to `.agentpack/backups/<pack>/<ts>.<nonce>/`, atomic write of every adapter file (tmp + rename), write `AGENTPACK.lock` at project root, write install manifest at `.agentpack/installed/<pack>.json`, append `install_commit`.
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

**History (`.agentpack/history.jsonl`, append-only, hash-chained)**

- ULID-style monotonic `id`, `previousEntryId` + `entryChecksum` form a hash chain.
- `entryChecksum = sha256(canonicalJson(entry minus entryChecksum))` — canonical JSON with recursively-sorted keys.
- mtime-based file lock around every append (single-writer guarantee under concurrent CLI invocations).
- WAL semantics: `install_begin` (with `plannedFiles[]`) before any file write; `install_commit` last; absence of commit is the crash signal.
- Rotation NOT supported in Phase 2 — file grows monotonically (documented in `docs/install.md`).

**CLI (six new subcommands)**

- `agentpack install <pack> --target X --profile Y --project <dir>` — diff + prompt + write. `--dry-run`, `--yes`, `--force`.
- `agentpack uninstall <packId>` — `--yes`, `--force`, `--force-restore`.
- `agentpack diff <pack>` — unified diff between current project and install plan.
- `agentpack history` — list, `--pack`, `--limit`, `--json`.
- `agentpack rollback [historyId]` — `--to`, `--pack`, `--cascade`, `--yes`.
- `agentpack verify <packId>` — drift report. `--chain` validates hash chain. Exit codes: 0 clean, 2 drift, 3 chain broken.

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

Initial MVP build of the AgentPack standard + AgentPack Registry monorepo.

- `@agentpack/core`: zod-backed schema, parser, validator, permission summary engine, risk engine, planner, install-plan builder, exportPack convenience entry, and seed-pack module.
- Five adapters: `claude-code`, `codex`, `cursor`, `chatgpt` (export-only), `generic`. Deterministic output, BEGIN/END markers in instruction files.
- `@agentpack/cli`: `init`, `validate`, `inspect`, `plan`, `pack export`, `doctor` (commander + picocolors + ora + diff).
- `@agentpack/registry`: Next.js App Router app with `/`, `/packs`, `/packs/[publisher]/[slug]`, `/validate`, `/docs`. Eight local components, Tailwind, seed data, server actions for validation.
- Example pack `examples/pr-quality` exercises every atom type and compiles to all five targets.
- 27 vitest tests across manifest, risk, and adapter coverage.
- README, `docs/agentpack-standard.md`, `docs/security.md`, `docs/adapters.md`, `docs/cli.md`.
- Project ISA at `ISA.md` — 68 testable ISCs covering build, schema, permissions, risk, CLI, adapters, registry, docs, and anti-criteria.
