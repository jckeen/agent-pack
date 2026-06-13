---
project: agent-pack
task: Iteration-5 launch-readiness verification — live install probe, dep CVE patch, doc rewrite, security tighten
effort: E5
phase: execute
progress: 267/267
mode: ALGORITHM
started: 2026-05-18T15:17:00-04:00
updated: 2026-05-19T14:05:00-04:00
iteration: 5
---

## Problem

AI tooling is fragmenting across Claude Code, Codex, Cursor, ChatGPT Apps, MCP-compatible clients, and other host platforms. Each exposes its own surface for instructions, rules, skills, hooks, commands, subagents, MCP tools, and plugins. There is no atomic, portable packaging standard with permission visibility, risk scoring, and cross-platform compilation. Authors duplicate work; users have no way to inspect what a pack will do before installing it.

## Vision

A developer drops a single `AGENTPACK.yaml` into a repo and runs `agentpack pack export --target claude-code --profile safe`. They see exactly which files will be written, which permissions are requested, the risk level, and which atoms will be skipped under the safe profile — before any write happens. Same source compiles cleanly to Codex `AGENTS.md` + `.codex/`, to Cursor `.cursor/rules/` + `.cursor/mcp.json`, to a ChatGPT app skeleton, and to generic `skills/` + `AGENTS.md`. Euphoric surprise: "I described the workflow once and four platforms got configured correctly, with the dangerous bits flagged in red."

## Out of Scope

- ~~Phase-2 install/uninstall~~ **NOW IN SCOPE (iteration-3)** — local install/uninstall, diff, backups, rollback, lockfile, history, verify, atom checksums all added.
- Phase-3 registry backend (database, publishing, search API) — seed data only; requires hosted infra not in this session
- Phase-4 cryptographic signatures (Sigstore/cosign) — schema fields present, runtime verification deferred to dedicated session. **Atom checksums (SHA-256 content addressing) IS now in scope** as the unlocking primitive.
- Phase-5 remote CLI installs (`agentpack install publisher/pack` over network) — requires hosted registry
- Phase-6 enterprise registries, SSO, audit logs — out
- Phase-7 Workgraph context-graph integration — out
- shadcn/ui dependency — use local Tailwind components
- AI social network features — explicitly separate product

## Principles

1. **Compile, don't replace.** AgentPack compiles to existing platform standards (CLAUDE.md, AGENTS.md, .cursor/rules, MCP).
2. **Permission transparency by default.** No silent capability escalation. Every dangerous atom is named in the plan.
3. **Atomicity.** The atom — instruction, rule, skill, hook, command, subagent, mcp_server, plugin, workflow, context_pack, template, eval — is the smallest installable unit.
4. **Determinism.** Same manifest + target + profile → byte-identical output (snapshot-testable).
5. **Honesty about platforms.** Unknown/changing platform surfaces (ChatGPT Apps, Codex hooks) ship as conservative/experimental, never as confident integration.
6. **Profile gradient.** safe → standard → full → enterprise lets users opt into risk explicitly.
7. **Supply-chain hygiene.** Pack ≈ npm package. Checksums, lockfiles, provenance are first-class even before verification lands.

## Constraints

- **Stack:** pnpm workspaces, TypeScript strict, Next.js App Router, Tailwind, zod, yaml, commander, picocolors, ora, diff, vitest, fs-extra.
- **Monorepo layout:** `packages/core`, `packages/cli`, `apps/registry`, `examples/pr-quality`, `docs/`, `spec/` (the build packet).
- **No actual install side-effects.** CLI must never write outside `--out` or current dir during `pack export`.
- **Adapter outputs must be deterministic** and use `<!-- BEGIN AGENTPACK: <id> --> ... <!-- END AGENTPACK: <id> -->` markers in instruction files.
- **Registry runs without a database.** Seed JSON is the source of truth in MVP.
- **CLI binary is `agentpack`** (renamed from `workgraph` in v0.5.1 iter-5).
- **Manifest version: `1.0`** (schema gate `^1\.0`).

## Goal

**Phase 1 (shipped):** Ship a working TypeScript monorepo where `pnpm install && pnpm build && pnpm test` succeed, every CLI command in `spec/08_ACCEPTANCE_CRITERIA.md` produces the documented output, the Next.js registry renders all seed packs with risk/compatibility/permission visibility, and the example PR-Quality pack compiles to all five targets with deterministic, marker-bounded files.

**Phase 2 (iteration-3):** Extend the same monorepo so `agentpack install examples/pr-quality --target claude-code --profile safe` shows a diff against the user's project root, prompts for confirmation, backs up any files it would overwrite, writes the new files, records an install manifest at `.agentpack/installed/<pack>.json`, writes a deterministic `AGENTPACK.lock` with per-atom SHA-256 checksums, and appends a `.agentpack/history.jsonl` entry — and `agentpack uninstall <pack>` precisely reverses it (created files removed, backups restored, manifest deleted, history append). `agentpack verify` reports any drift between the on-disk files and the lockfile's recorded checksums. `agentpack rollback <history-entry>` restores from a specific history entry. Test coverage stays ≥85% lines / ≥75% branches. The same install command appears in the registry web app's `InstallCommandBox` on every pack detail page.

## Criteria

### Build & install

- [x] ISC-1: `pnpm install` exits 0 at repo root
- [x] ISC-2: `pnpm -r build` exits 0 (core, cli, registry)
- [x] ISC-3: `pnpm -r test` exits 0 with all vitest suites passing
- [x] ISC-4: `pnpm --filter @agentpack/registry dev` boots Next.js on a port
- [x] ISC-5: `pnpm --filter @agentpack/cli build` exits 0 and emits `dist/index.js`
- [x] ISC-6: TypeScript `strict: true` everywhere; `pnpm -r typecheck` clean

### Schema & validation

- [x] ISC-7: Zod schema accepts the bundled example manifest verbatim
- [x] ISC-8: Manifest with duplicate atom IDs fails validation with a clear error
- [x] ISC-9: Manifest with profile referencing missing atom ID fails validation
- [x] ISC-10: Manifest missing required metadata fields fails validation
- [x] ISC-11: `agentpack` version not matching `^1\.0` fails validation
- [x] ISC-12: Atom type outside the 12-type enum fails validation

### Permissions & risk

- [x] ISC-13: `summarizePermissions` returns categorized list with descriptions
- [x] ISC-14: `computeRisk` returns "high" when any included atom has `risk_level: high`
- [x] ISC-15: Hook atom is classified `high`
- [x] ISC-16: MCP server requiring secrets is classified `high` and surfaces `GITHUB_TOKEN`
- [x] ISC-17: Safe profile excludes all hooks and MCP servers
- [x] ISC-18: Risk monotonically non-decreasing as profile widens safe→standard→full
- [x] ISC-19: Permission summary names `shell.execution` for hook atom
- [x] ISC-20: Permission summary names `secrets.env`+`network.access`+`external_api.access` for GitHub MCP

### CLI behavior

- [x] ISC-21: `agentpack validate examples/pr-quality` exits 0 with success message
- [x] ISC-22: `agentpack inspect examples/pr-quality` prints name, version, publisher, compatibility, profiles, atoms, risk, permissions
- [x] ISC-23: `agentpack plan examples/pr-quality --target claude-code --profile safe` prints LOW risk
- [x] ISC-24: `agentpack plan examples/pr-quality --target claude-code --profile full` warns about hook
- [x] ISC-25: `agentpack plan ... --profile full` warns about shell execution
- [x] ISC-26: `agentpack plan ... --profile full` warns about GitHub MCP
- [x] ISC-27: `agentpack plan ... --profile full` warns about `GITHUB_TOKEN` secret
- [x] ISC-28: `agentpack init` writes a starter `AGENTPACK.yaml` in CWD
- [x] ISC-29: `agentpack doctor` reports node version, pnpm presence, working dir status
- [x] ISC-30: CLI exits non-zero on validation failure

### Adapter outputs (deterministic)

- [x] ISC-31: `pack export --target claude-code` writes `CLAUDE.md`
- [x] ISC-32: `pack export --target claude-code` writes `.claude/skills/code-review/SKILL.md`
- [x] ISC-33: `pack export --target claude-code --profile standard` writes `.claude/agents/security-reviewer.md`
- [x] ISC-34: `pack export --target claude-code --profile full` writes `.claude/settings.json` with hook block
- [x] ISC-35: `pack export --target codex` writes `AGENTS.md`
- [x] ISC-36: `pack export --target codex` writes `.codex/config.toml`
- [x] ISC-37: `pack export --target codex` writes `.codex/skills/code-review/SKILL.md`
- [x] ISC-38: `pack export --target codex --profile full` writes `.codex/hooks.json`
- [x] ISC-39: `pack export --target cursor` writes `AGENTS.md`
- [x] ISC-40: `pack export --target cursor` writes `.cursor/rules/security-review-required.mdc`
- [x] ISC-41: `pack export --target cursor --profile full` writes `.cursor/mcp.json` with github server
- [x] ISC-42: `pack export --target chatgpt` writes `project-instructions.md`
- [x] ISC-43: `pack export --target chatgpt` writes `app-manifest.json`
- [x] ISC-44: `pack export --target chatgpt --profile full` writes `mcp-server/src/tools/pr-summary.ts` stub
- [x] ISC-45: `pack export --target generic` writes `AGENTS.md`
- [x] ISC-46: `pack export --target generic` writes `skills/code-review/SKILL.md`
- [x] ISC-47: `pack export --target generic` writes `agentpack.json`
- [x] ISC-48: All instruction outputs contain `<!-- BEGIN AGENTPACK: agentpack.pr-quality -->` marker
- [x] ISC-49: Re-running the same export twice produces byte-identical output

### Registry web app

- [x] ISC-50: `/` homepage renders product positioning and CTA
- [x] ISC-51: `/packs` lists all 10 seed packs from `seed/seed-packs.json`
- [x] ISC-52: `/packs` supports tag and risk filtering client-side
- [x] ISC-53: `/packs/agentpack/pr-quality` renders detail page
- [x] ISC-54: Detail page renders CompatibilityMatrix (5 targets × status)
- [x] ISC-55: Detail page renders RiskBadge with computed risk
- [x] ISC-56: Detail page renders PermissionSummary block
- [x] ISC-57: Detail page renders InstallCommandBox with `npx agentpack pack export ...`
- [x] ISC-58: Detail page renders AtomList with all 7 PR-Quality atoms
- [x] ISC-59: Detail page renders ManifestViewer (raw YAML preview)
- [x] ISC-60: `/validate` accepts pasted YAML and reports valid/invalid with errors
- [x] ISC-61: `/docs` renders standard, security, adapters, CLI overview

### Documentation

- [x] ISC-62: Root `README.md` explains standard, CLI, security model, adapters, limitations
- [x] ISC-63: `docs/agentpack-standard.md`, `docs/security.md`, `docs/adapters.md`, `docs/cli.md` all populated

### Anti-criteria & antecedents

- [x] ISC-64: Anti: CLI never writes outside `--out` directory during `pack export`
- [x] ISC-65: Anti: ChatGPT adapter never claims automatic installation
- [x] ISC-66: Anti: No adapter silently drops dangerous atoms — they appear in `warnings[]` or `unsupportedAtoms[]`
- [x] ISC-67: Anti: `pack export` does not crash on unknown atom type — emits warning
- [x] ISC-68: Antecedent: User has node ≥18 and pnpm ≥9 (doctor command verifies)

### Phase 2 — Install engine (core)

- [x] ISC-69: `planInstall(options)` returns `InstallPlanV2` with `created[]`, `modified[]`, `unchanged[]`, `conflicts[]`
- [x] ISC-70: `planInstall` reads existing files at target paths to compute diff (not just naive overwrite)
- [x] ISC-71: `applyInstall` writes only files whose target path is inside `projectRoot` (realpath check)
- [x] ISC-72: `applyInstall` refuses if `projectRoot` does not exist or is not a directory
- [x] ISC-73: `applyInstall` backs up every overwritten file to `.agentpack/backups/<packId>/<timestamp>/` before writing
- [x] ISC-74: `applyInstall` writes install manifest at `.agentpack/installed/<packId>.json` matching `InstallManifestV1`
- [x] ISC-75: Install manifest contains `packId`, `packVersion`, `target`, `profile`, `installedAt`, `created[]`, `modified[]`, `backups[]`, `atomIds[]`, `lockfileChecksum`
- [x] ISC-76: `applyInstall` writes `AGENTPACK.lock` at project root matching `LockfileV1` schema
- [x] ISC-77: Lockfile contains per-atom SHA-256 `contentChecksum` for every included atom
- [x] ISC-78: Lockfile contains `packId`, `packVersion`, `target`, `profile`, `adapterVersion`, `cliVersion`, `manifestChecksum`, `installedAt`
- [x] ISC-79: Two consecutive `install` runs into a clean projectRoot produce byte-identical lockfiles (determinism)
- [x] ISC-80: `applyInstall` appends a `.agentpack/history.jsonl` line with `action: install`, `packId`, `timestamp`, `manifestPath`
- [x] ISC-81: `uninstall(packId, projectRoot)` reads install manifest, restores backups, deletes created files, removes manifest
- [x] ISC-82: `uninstall` is exact inverse: install → uninstall leaves no residue under `.agentpack/installed/` for that pack
- [x] ISC-83: `uninstall` appends `.agentpack/history.jsonl` with `action: uninstall`
- [x] ISC-84: `uninstall` refuses if no install manifest exists for that packId
- [x] ISC-85: `rollback(historyEntryId)` restores project to the state before that history entry (re-runs reverse of every later install/uninstall)
- [x] ISC-86: `verify(packId, projectRoot)` computes current on-disk SHA-256 of every lockfile-tracked file and reports `clean` / `drift[]`
- [x] ISC-87: `verify` flags missing files as `missing`, modified files as `modified`, unexpected files as `extra` only inside marker bounds
- [x] ISC-88: `computeAtomChecksums(plan)` is pure (same input → same SHA-256), independent of timestamps
- [x] ISC-89: Lockfile schema is zod-validated and exported from `@agentpack/core`

### Phase 2 — CLI surface

- [x] ISC-90: `agentpack install <pack> --target X --profile Y --project .` prints diff and prompts for `[y/N]`
- [x] ISC-91: `agentpack install ... --yes` skips the prompt
- [x] ISC-92: `agentpack install ... --dry-run` prints diff and exits 0 without writing
- [x] ISC-93: `agentpack install` exits non-zero if target paths conflict with non-AgentPack-marked content (unless `--force`)
- [x] ISC-94: `agentpack uninstall <packId>` prompts unless `--yes`, then restores
- [x] ISC-95: `agentpack diff <pack> --target X --profile Y` prints unified diff and exits without writing
- [x] ISC-96: `agentpack history` lists every entry in `.agentpack/history.jsonl` (most recent first)
- [x] ISC-97: `agentpack history --pack <id>` filters by pack
- [x] ISC-98: `agentpack rollback <history-id> --yes` restores
- [x] ISC-99: `agentpack verify <packId>` exits 0 if clean, 2 if drift, 1 on usage error
- [x] ISC-100: `agentpack install` colored, profile risk surfaced _before_ the prompt (consistent with `plan` UX)
- [x] ISC-101: All Phase-2 commands appear in `agentpack --help`

### Phase 2 — Registry web app

- [x] ISC-102: `InstallCommandBox` shows `npx agentpack install <pack> --target <t> --profile <p>` alongside the existing `pack export` line
- [x] ISC-103: Pack detail page includes a "Lockfile preview" section showing the synthesized lockfile shape for the active profile/target
- [x] ISC-104: `/docs/install` route renders install/uninstall/rollback/verify reference

### Phase 2 — Tests

- [x] ISC-105: `vitest` suite `install.test.ts` — happy path: install into temp dir writes expected files + manifest + lockfile + history
- [x] ISC-106: `install.test.ts` — refuses to write outside projectRoot (symlink escape attempt)
- [x] ISC-107: `install.test.ts` — determinism: two installs into separate clean dirs → identical lockfile contents (ignoring `installedAt`)
- [x] ISC-108: `uninstall.test.ts` — roundtrip: install → uninstall → pre-install state restored bit-identically
- [x] ISC-109: `uninstall.test.ts` — missing manifest → throws `UninstallManifestNotFound`
- [x] ISC-110: `lockfile.test.ts` — schema accepts known shape, rejects unknown fields when strict
- [x] ISC-111: `lockfile.test.ts` — checksum determinism: same manifest+target+profile → same atom checksums
- [x] ISC-112: `checksum.test.ts` — SHA-256 of canonical content matches `openssl dgst -sha256` of file
- [x] ISC-113: `diff.test.ts` — produces unified diff with marker context
- [x] ISC-114: `verify.test.ts` — clean install reports `clean: true`
- [x] ISC-115: `verify.test.ts` — mutated file reports `drift[]` with the path
- [x] ISC-116: `verify.test.ts` — deleted file reports `missing[]`
- [x] ISC-117: `rollback.test.ts` — three-step history (install → install → uninstall) rolled back to step 0 yields empty `.agentpack/installed/`
- [x] ISC-118: CLI subprocess test — `agentpack install` with `--dry-run` exits 0 and writes nothing
- [x] ISC-119: CLI subprocess test — `agentpack install --yes` succeeds, `uninstall --yes` succeeds, `history` lists 2 entries
- [x] ISC-120: CLI subprocess test — `agentpack verify` after manual file mutation exits 2 with drift report
- [x] ISC-121: Coverage threshold preserved: lines ≥85%, functions ≥85%, statements ≥85%, branches ≥75% post-Phase-2

### Phase 2 — Documentation & release

- [x] ISC-122: `docs/install.md` written: install/uninstall/diff/verify/rollback reference
- [x] ISC-123: `README.md` quickstart section gains `agentpack install examples/pr-quality --target claude-code --profile safe --dry-run` line
- [x] ISC-124: `CHANGELOG.md` gains `## 0.2.0 — 2026-05-18` entry covering Phase 2 additions
- [x] ISC-125: `package.json` versions bumped to `0.2.0` in core, cli, registry, root
- [x] ISC-126: `STATUS.md` written at repo root reflecting Phase 2 shipped + Phase 3+ deferred

### Phase 2 — Anti-criteria & antecedents

- [x] ISC-127: Anti: `agentpack install` never writes outside `projectRoot` (verified by symlink-escape test)
- [x] ISC-128: Anti: `agentpack install` never writes a hook atom under `safe` profile
- [x] ISC-129: Anti: `uninstall` never deletes a file it did not create (compared against `created[]`)
- [x] ISC-130: Anti: `uninstall` never silently re-writes a backup over a user-edited file — surfaces `conflicts[]` and refuses unless `--force-restore`
- [x] ISC-131: Anti: lockfile checksums are NOT salted with timestamps (otherwise determinism breaks)
- [x] ISC-132: Anti: install manifest does NOT embed absolute paths (must be project-relative) so the same `.agentpack/` is portable
- [x] ISC-133: Anti: history.jsonl never logs secret values; only structural keys (packId, target, profile)
- [x] ISC-134: Anti: `verify` does NOT panic on lockfile-tracked file being absent — reports `missing[]` and exits 2
- [x] ISC-135: Anti: `rollback` does NOT cross packId boundaries — only undoes the named pack's history slice
- [x] ISC-136: Antecedent: `.agentpack/` is git-ignorable; install does NOT alter `.gitignore` automatically (advisory message only)
- [x] ISC-137: Antecedent: User can opt into `.agentpack/` committed for reproducibility (lockfile is meant to be committed)

### Phase 2 — CI & integration

- [x] ISC-138: `.github/workflows/ci.yml` smoke step `agentpack install examples/pr-quality --target generic --profile safe --project /tmp/agentpack-smoke --yes` exits 0
- [x] ISC-139: CI smoke `agentpack verify` after install exits 0
- [x] ISC-140: CI smoke `agentpack uninstall examples/pr-quality --yes --project /tmp/agentpack-smoke` exits 0
- [x] ISC-141: `pnpm verify` (typecheck + lint + test:coverage + build) exits 0 on iteration-3
- [x] ISC-142: All Phase-1 ISCs (1..68) still pass after Phase-2 changes (no regression)

### Iteration-4 / Phase 3 + Phase 5 scaffold (this session)

#### Phase 3.A — `packages/db` Drizzle schema

- [x] ISC-151: `packages/db/package.json` declares `@agentpack/db` workspace package
- [x] ISC-152: `packages/db/drizzle.config.ts` configures Drizzle migrations (`out: ./migrations`)
- [x] ISC-153: `users` table schema: `id`, `github_id`, `username`, `email`, `avatar_url`, `created_at`
- [x] ISC-154: `publishers` table schema: `id`, `slug` (unique), `display_name`, `verified`, `created_at`
- [x] ISC-155: `publisher_members` join table: `publisher_id`, `user_id`, `role` (`owner|maintainer`)
- [x] ISC-156: `packs` table: `id`, `publisher_id`, `slug`, `description`, `tags`, `latest_version_id`, `created_at`
- [x] ISC-157: `packs.search` tsvector generated column (FTS, weighted name+desc+tags)
- [x] ISC-158: GIN index `packs_search_idx` on `packs.search`
- [x] ISC-159: `pack_versions`: `id`, `pack_id`, `version`, `status`, `manifest_sha256`, `published_at`, `published_by`
- [x] ISC-1- [x] ISC-160: `pack_versions.status` enum: `published|deprecated|yanked|quarantined|blocked` (Phase 4-ready)
- [x] ISC-1- [x] ISC-161: `pack_versions` unique index on `(pack_id, version)`
- [x] ISC-1- [x] ISC-162: `atoms` table: `id`, `pack_version_id`, `atom_id`, `type`, `risk_level`, `metadata` jsonb
- [x] ISC-1- [x] ISC-163: `pack_files` table: `id`, `pack_version_id`, `atom_id?`, `path`, `sha256`, `bytes`, `r2_key`
- [x] ISC-1- [x] ISC-164: `compatibilities` table: `pack_version_id`, `target`, `status`
- [x] ISC-1- [x] ISC-165: `api_tokens` table per D3.2: `id`, `user_id`, `publisher_id?`, `name`, `token_prefix`, `token_sha256`, `scopes` jsonb, `last_used_at`, `created_at`, `revoked_at`
- [x] ISC-1- [x] ISC-166: `api_tokens.token_sha256` is unique
- [x] ISC-1- [x] ISC-167: `publishes` (two-phase pending state): `id`, `pack_id?`, `publisher_slug`, `pack_slug`, `version`, `status`, `expires_at`, `created_by`, `presigned_files` jsonb
- [x] ISC-1- [x] ISC-168: `reviews` table schema (POST 501 in v0.3): `id`, `pack_version_id`, `user_id`, `rating`, `body`, `created_at`
- [x] ISC-1- [x] ISC-169: `audit_events` table (Phase 6-reserved): `id`, `org_id?`, `actor_user_id`, `action`, `target_type`, `target_id`, `previous_entry_id`, `entry_checksum`, `created_at`
- [x] ISC-1- [x] ISC-170: First Drizzle migration emitted under `packages/db/migrations/0000_init.sql`
- [x] ISC-1- [x] ISC-171: `packages/db/src/index.ts` exports schemas + `getDb(url)` Drizzle client factory
- [x] ISC-1- [x] ISC-172: `packages/db/src/queries/packs.ts` exports `getPackBySlug`, `listPacks`, `listPackVersions`, `getLatestVersion`
- [x] ISC-1- [x] ISC-173: `packages/db/src/queries/publishers.ts` exports `getPublisherBySlug`, `userHasPublisherScope`
- [x] ISC-1- [x] ISC-174: `packages/db/src/queries/tokens.ts` exports `findActiveTokenByHash`, `mintToken`, `revokeToken`, `listUserTokens`
- [x] ISC-1- [x] ISC-175: `packages/db/src/queries/publishes.ts` exports `createPendingPublish`, `finalizePublish`, `abortPublish`
- [x] ISC-1- [x] ISC-176: `packages/db/tsconfig.json` extends repo base with `composite: true`
- [x] ISC-1- [x] ISC-177: `packages/db/vitest.config.ts` configured for unit tests (no live DB needed)
- [x] ISC-1- [x] ISC-178: `packages/db/tests/schema.test.ts` asserts every table's column shape compiles
- [x] ISC-1- [x] ISC-179: `pnpm --filter @agentpack/db build` exits 0

#### Phase 3.B — Registry auth + tokens

- [x] ISC-1- [x] ISC-180: `apps/registry/lib/auth.ts` exports NextAuth v5 config with GitHub OAuth provider
- [x] ISC-1- [x] ISC-181: NextAuth session callback enriches session with `user.id` + `user.publisherSlugs`
- [x] ISC-1- [x] ISC-182: `apps/registry/app/api/auth/[...nextauth]/route.ts` exposes NextAuth handler
- [x] ISC-1- [x] ISC-183: `apps/registry/lib/tokens.ts` exports `generateToken()` returning `{ token, sha256, prefix }`
- [x] ISC-1- [x] ISC-184: `apps/registry/lib/tokens.ts` exports `verifyBearer(req)` resolving user+scopes or returning null (caller maps to 401)
- [x] ISC-1- [x] ISC-185: Token verification updates `last_used_at` async (fire-and-forget pattern)
- [x] ISC-1- [x] ISC-186: `apps/registry/app/(authed)/tokens/page.tsx` lists tokens for current user
- [x] ISC-1- [x] ISC-187: `apps/registry/app/api/tokens/route.ts` POST mints token, GET lists user tokens
- [x] ISC-1- [x] ISC-188: `apps/registry/app/api/tokens/[id]/route.ts` DELETE revokes token (sets `revoked_at`)
- [x] ISC-1- [x] ISC-189: Revoked tokens fail `verifyBearer` (returns null, route maps to 401)
- [x] ISC-1- [x] ISC-190: Token missing `publish:packs` scope cannot hit `/api/publish/*` (403)
- [x] ISC-1- [x] ISC-191: Unit test: `generateToken` produces `agp_live_` prefix + 32-char body
- [x] ISC-1- [x] ISC-192: Unit test: `sha256(token)` is lowercase hex, 64 chars

#### Phase 3.C — Publish API (two-phase)

- [x] ISC-1- [x] ISC-193: `apps/registry/app/api/publish/init/route.ts` POST validates body via zod
- [x] ISC-1- [x] ISC-194: `/api/publish/init` returns 401 without valid bearer token
- [x] ISC-1- [x] ISC-195: `/api/publish/init` returns 403 if token publisher scope mismatches body publisher
- [x] ISC-1- [x] ISC-196: `/api/publish/init` returns 409 if `(publisher, pack, version)` already exists
- [x] ISC-1- [x] ISC-197: `/api/publish/init` returns `{ publish_id, presignedUploads: [{path, url, headers}] }`
- [x] ISC-1- [x] ISC-198: `apps/registry/lib/r2.ts` exports `r2Client()` + `presignPutUrl(key, sha256, bytes)`
- [x] ISC-1- [x] ISC-199: `r2.ts` uses `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` against R2 endpoint
- [x] ISC-200: `apps/registry/app/api/publish/[publishId]/finalize/route.ts` POST verifies each blob's sha256
- [x] ISC-201: `/finalize` inserts `pack_versions`, `atoms`, `pack_files`, `compatibilities` in one tx
- [x] ISC-202: `/finalize` marks publish `status=completed` and sets `packs.latest_version_id`
- [x] ISC-203: `/finalize` returns 422 with `{ mismatched: [{path, expected, got}] }` on hash mismatch
- [x] ISC-204: `/finalize` of expired (>24h) publish returns 410 Gone
- [x] ISC-205: Unit test: publish-init zod schema accepts valid body
- [x] ISC-206: Unit test: publish flow rejects duplicate-version 409

#### Phase 3.D — Read API

- [x] ISC-207: `apps/registry/app/api/packs/route.ts` GET lists packs with paging + tag + risk filter
- [x] ISC-208: `apps/registry/app/api/packs/[publisher]/[pack]/route.ts` GET returns pack + version list
- [x] ISC-209: `apps/registry/app/api/packs/[publisher]/[pack]/versions/[version]/route.ts` GET returns version metadata
- [x] ISC-210: `apps/registry/app/api/packs/[publisher]/[pack]/versions/[version]/manifest.yaml/route.ts` streams R2 bytes
- [x] ISC-211: `apps/registry/app/api/packs/[publisher]/[pack]/versions/[version]/atoms/[atomId]/[...path]/route.ts` streams atom bytes
- [x] ISC-212: `apps/registry/app/api/search/route.ts` GET runs Postgres FTS via `to_tsquery`
- [x] ISC-213: `apps/registry/app/api/packs/[publisher]/[pack]/reviews/route.ts` GET returns reviews; POST returns 501
- [x] ISC-214: Manifest.yaml route sets `Cache-Control: public, max-age=31536000, immutable`
- [x] ISC-215: Quarantined version's manifest.yaml route returns 451 with quarantine reason

#### Phase 3.E — Seed import + UI refactor

- [x] ISC-216: `scripts/seed-import.ts` exists and reads `seed/seed-packs.json`
- [x] ISC-217: `seed-import` is idempotent: second run logs `"0 inserted, N skipped"`
- [x] ISC-218: `pnpm seed:import` script wired in root `package.json`
- [x] ISC-219: `apps/registry/lib/db.ts` exports `getDb()` reading `DATABASE_URL`
- [x] ISC-220: `apps/registry/lib/seed.ts` refactored: DB-backed when `DATABASE_URL` set, else JSON fallback
- [x] ISC-221: `apps/registry/app/packs/page.tsx` renders from DB-backed `listPacks()`
- [x] ISC-222: `apps/registry/app/packs/[publisher]/[slug]/page.tsx` renders from DB-backed `getPackBySlug()`
- [x] ISC-223: Anti: Removing `DATABASE_URL` falls back to JSON without throwing

#### Phase 3.F — CLI publish/login/whoami/tokens

- [x] ISC-224: `packages/cli/src/commands/login.ts` opens browser to `<registry>/cli/auth` with device code
- [x] ISC-225: `login` polls `/api/cli/auth/poll` until token returned, writes `~/.agentpack/credentials.json`
- [x] ISC-226: `~/.agentpack/credentials.json` has `0o600` perms on POSIX
- [x] ISC-227: `packages/cli/src/commands/whoami.ts` reads creds, calls `/api/me`, prints user + publishers
- [x] ISC-228: `packages/cli/src/commands/tokens.ts` `list|create|revoke` subcommands
- [x] ISC-229: `packages/cli/src/commands/publish.ts` reads manifest, computes per-file sha256
- [x] ISC-230: `publish` POSTs init, uploads each file to presigned URL, POSTs finalize
- [x] ISC-231: `publish` exits 0 on success and prints registry URL
- [x] ISC-232: `publish` exits non-zero on 409 (already published)
- [x] ISC-233: CLI publish/login/whoami/tokens registered in `packages/cli/src/index.ts`

#### Phase 5.A — Remote install resolver

- [x] ISC-234: `packages/cli/src/commands/install.ts` accepts `<publisher>/<pack>[@<version>]` identity
- [x] ISC-235: `RegistryClient` class in `packages/core/src/registry-client/` fetches manifest+atoms
- [x] ISC-236: Resolver picks latest non-prerelease non-yanked version on missing `@version`
- [x] ISC-237: Resolver verifies each fetched file's sha256 against registry-declared sha256
- [x] ISC-238: Hash mismatch raises `IntegrityError` and exits 7
- [x] ISC-239: Resolved bytes feed into existing `planInstall`/`applyInstall` from Phase 2
- [x] ISC-240: `--registry <url>` flag overrides default `https://registry.agentpack.dev`

#### Phase 5.B — Local cache

- [x] ISC-241: `packages/core/src/cache/` blob store at `~/.agentpack/cache/blobs/<sha[0..2]>/<sha>`
- [x] ISC-242: Cache lookup runs before network fetch; cache miss → fetch + write + return
- [x] ISC-243: `agentpack cache size` prints total bytes + entry count
- [x] ISC-244: `agentpack cache prune --max-age 30d` removes blobs older than threshold
- [x] ISC-245: `agentpack cache clear` empties blob store
- [x] ISC-246: Anti: `cache prune` never deletes outside `~/.agentpack/cache/blobs/`

#### Phase 5.C — Policy enforcement

- [x] ISC-247: `packages/core/src/policy/schema.ts` zod schema for `agentpack.policy.json` per D5.4
- [x] ISC-248: `loadPolicy(projectRoot)` reads file, validates, returns typed policy or null
- [x] ISC-249: `enforcePolicy(policy, installPlan, registryUrl)` returns `{ ok: true } | { ok: false, violations: [...] }`
- [x] ISC-250: Policy violation in CLI install exits 6
- [x] ISC-251: `requireSignature: true` rejects packs with empty `lockfile.signatures` (Phase 4-ready)
- [x] ISC-252: `deniedAtomTypes: ["hook"]` rejects plans with hook atoms
- [x] ISC-253: `allowedProfiles: ["safe"]` rejects `--profile standard|full`
- [x] ISC-254: `registries.allowed` rejects `--registry` outside allowlist

#### Phase 3 + 5 — Tests + docs + anti-criteria

- [x] ISC-255: New vitest files: `db/schema.test.ts`, `cli/publish.test.ts`, `cli/install-remote.test.ts`, `core/policy.test.ts`, `core/registry-client.test.ts`
- [x] ISC-256: `pnpm -r test` exits 0 after iteration-4 additions
- [x] ISC-257: `pnpm -r typecheck` exits 0
- [x] ISC-258: `pnpm -r build` exits 0 across all packages including new `@agentpack/db`
- [x] ISC-259: `docs/registry.md` written: schema, auth, publish flow, search, reviews-deferred
- [x] ISC-260: `docs/publish.md` written: `agentpack publish` reference + token + scope model
- [x] ISC-261: `docs/remote-install.md` written: identity grammar, cache, exit codes
- [x] ISC-262: `docs/policy.md` written: schema + examples + enforcement order
- [x] ISC-263: Anti: `agentpack publish` never includes env-var secrets in init body
- [x] ISC-264: Anti: Cache fetch never reads outside `~/.agentpack/cache/`
- [x] ISC-265: Anti: Token printed in CLI output is masked to `agp_live_xxxx…lastfour`
- [x] ISC-266: Anti: Remote install never bypasses Phase 2 realpath containment
- [x] ISC-267: Anti: Manifest.yaml route streams from R2 (never echoes client-supplied bytes)

### Phase 2 — WAL + chain integrity (advisor-driven)

- [x] ISC-143: `install` writes `install_begin` history entry with `plannedFiles[]` BEFORE writing any project files
- [x] ISC-144: `install` writes `install_commit` history entry as its LAST action; absence of commit = crash signal
- [x] ISC-145: Recovery path: dangling `install_begin` (no matching `install_commit`) detected by `recoverIncomplete()` at next CLI invocation
- [x] ISC-146: Recovery: when all staged files present + checksums match → roll forward by writing `install_commit`
- [x] ISC-147: Recovery: when staged files partial/corrupt → roll back by deleting them and appending `install_rollback_recovery` entry
- [x] ISC-148: `appendHistoryEntry` uses `proper-lockfile` (or equivalent flock) to serialize concurrent writers
- [x] ISC-149: `entryChecksum` is sha256 hex (lowercased) of canonical JSON (recursively-sorted keys) of the entry minus the `entryChecksum` field
- [x] ISC-150: `rollback` refuses superseded installs by default; `--to <id>` cascade is explicit and prints what it'll undo

## Test Strategy

| isc          | type         | check                                                               | threshold                  | tool                         |
| ------------ | ------------ | ------------------------------------------------------------------- | -------------------------- | ---------------------------- |
| ISC-1..6     | build        | exit code                                                           | 0                          | `pnpm` via Bash              |
| ISC-7..12    | schema       | zod parse outcome                                                   | true/false                 | `vitest`                     |
| ISC-13..20   | logic        | function return                                                     | exact match                | `vitest`                     |
| ISC-21..30   | cli          | stdout grep + exit                                                  | substring match            | `Bash`                       |
| ISC-31..47   | files        | `Read` after export                                                 | file exists + content      | `Bash` + `Read`              |
| ISC-48..49   | determinism  | diff between two runs                                               | empty diff                 | `Bash diff`                  |
| ISC-50..61   | ui           | route loads + text present                                          | HTTP 200 + grep            | `curl` to dev server         |
| ISC-62..63   | docs         | files present + sections                                            | grep section headers       | `Bash`                       |
| ISC-64..68   | anti         | negative probe                                                      | property not present       | mixed                        |
| ISC-69..89   | logic        | core install/uninstall/verify return shape                          | exact match                | `vitest`                     |
| ISC-90..101  | cli          | stdout + filesystem state post-command                              | exit code + file existence | `Bash` subprocess            |
| ISC-102..104 | ui           | rendered HTML contains expected install string                      | grep                       | `curl` to dev server         |
| ISC-105..120 | tests        | vitest case count + pass                                            | all green                  | `vitest`                     |
| ISC-121      | coverage     | vitest --coverage thresholds                                        | ≥85%/85%/85%/75%           | `vitest`                     |
| ISC-122..126 | docs/release | files present + version strings                                     | grep                       | `Bash`                       |
| ISC-127..137 | anti         | negative probe (escape, no-cross-pack, no-secrets)                  | refused/missing            | mixed                        |
| ISC-138..142 | ci           | github workflow step exit                                           | 0                          | `Bash` simulating CI step    |
| ISC-143..150 | wal/chain    | begin/commit ordering + lock + canonical hash + supersession refuse | exact behavior             | `vitest` + concurrency probe |

## Features

| name                                  | satisfies                 | depends_on                               | parallelizable          |
| ------------------------------------- | ------------------------- | ---------------------------------------- | ----------------------- |
| monorepo-skeleton                     | ISC-1, ISC-2              | —                                        | no                      |
| core-schema                           | ISC-7..12                 | monorepo-skeleton                        | no                      |
| core-permissions-risk                 | ISC-13..20                | core-schema                              | no                      |
| core-planner                          | ISC-21..30 (planner half) | core-permissions-risk                    | no                      |
| adapter-claude-code                   | ISC-31..34                | core-planner                             | yes                     |
| adapter-codex                         | ISC-35..38                | core-planner                             | yes                     |
| adapter-cursor                        | ISC-39..41                | core-planner                             | yes                     |
| adapter-chatgpt                       | ISC-42..44                | core-planner                             | yes                     |
| adapter-generic                       | ISC-45..47                | core-planner                             | yes                     |
| determinism-marker                    | ISC-48..49                | all adapters                             | no                      |
| cli-commands                          | ISC-21..30                | core-planner                             | no                      |
| registry-app                          | ISC-50..61                | core (typed seed import)                 | partial-parallel        |
| test-suite                            | ISC-3, ISC-7..49          | all above                                | partial-parallel        |
| docs                                  | ISC-62..63                | all above                                | yes                     |
| anti-criteria-audit                   | ISC-64..68                | all above                                | no                      |
| **iteration-3 / Phase 2 starts here** |                           |                                          |                         |
| install-engine-core                   | ISC-69..89                | core-planner, all adapters               | no (touches one module) |
| install-cli-surface                   | ISC-90..101               | install-engine-core                      | yes (per-command files) |
| install-registry-ui                   | ISC-102..104              | install-engine-core (lockfile shape)     | yes                     |
| install-tests                         | ISC-105..120              | install-engine-core, install-cli-surface | partial-parallel        |
| install-coverage                      | ISC-121                   | install-tests                            | no (whole-suite metric) |
| install-docs-release                  | ISC-122..126              | all above                                | yes                     |
| install-anti-audit                    | ISC-127..137              | install-engine-core, install-cli-surface | no                      |
| install-ci                            | ISC-138..142              | install-cli-surface                      | no                      |

## Decisions

- **2026-05-18 (OBSERVE):** Project ISA lives at `agent-pack/ISA.md` (project-scoped, v6.0+). Spec packet docs moved to `spec/` to keep root clean. The spec packet IS the substantive ISA pre-population.
- **2026-05-18 (OBSERVE):** Skipping ISA skill scaffold workflow — the spec packet at `spec/00..10_*.md` is denser than what scaffold would produce. ISA is consolidated by hand into 12-section canonical form here.
- **2026-05-18 (OBSERVE) — show-your-math, delegation floor:** E5 soft floor is ≥4 delegation; selecting 2 (Forge optional for parallel adapter codegen, Cato mandatory at VERIFY). Rationale: spec is sufficiently concrete that single-author execution is faster than multi-agent coordination; using Forge for parallel codegen would create merge conflicts on shared types in `packages/core/src/index.ts`. Anvil whole-project review would duplicate Cato's job at higher latency. Background research agents are not needed — no unknown libraries. Recording this rationale per soft-floor rules.
- **2026-05-18 (PLAN):** Risk model — atom risks combine by `max()` over included atoms; profile risk = max(atom risks of profile members). MCP-with-secrets and shell-exec hooks pin to `high`. Critical reserved for combinations (shell+secrets+network+filesystem-write) per spec.
- **2026-05-18 (PLAN):** Cursor adapter — `.cursor/rules/*.mdc` for `rule` atoms, `.cursor/mcp.json` for mcp_server atoms, `AGENTS.md` for instructions. Hooks emit warnings (no stable Cursor hook target yet).
- **2026-05-18 (PLAN):** ChatGPT adapter is **export-only** per spec — emits MCP server skeleton (one tool stub per `command` atom), `project-instructions.md`, `app-manifest.json`. Marks all output `conservative/proposed`.

- **2026-05-18 (OBSERVE iteration-3):** Phase 2 scope decision. User requested "Phase 2 + the rest". Phases 3-7 (registry backend, signatures, remote install, enterprise, AgentPack integration) all require external infrastructure (hosted DB, hosted registry, SSO, signing keys) that does not exist in this session. Building stubs would be dishonest. In scope this iteration: Phase 2 (install/uninstall/diff/backup/lockfile/history/rollback) PLUS the local-feasible Phase-4 unlock primitive (per-atom SHA-256 content checksums + `agentpack verify` drift detection). Out of this iteration: cryptographic signatures, hosted registry, remote `agentpack install publisher/pack`, enterprise policy. Phases 3+ stay listed in Out of Scope.

- **2026-05-18 (OBSERVE iteration-3) — context-override effort:** Classifier returned `MODE: ALGORITHM TIER: E3 SOURCE: fail-safe` after 25s timeout. User invoked `/max` which forces Advanced+ and "If the task is large enough, use Comprehensive (64+)." Scope (≥74 new ISCs, ≥6 new CLI commands, ≥5 new core modules, ≥1 registry surface, ≥4 doc files, security hardening, cross-vendor audit) puts this firmly at E5. Set `effort_source: context-override`.

- **2026-05-18 (OBSERVE iteration-3) — show-your-math, delegation floor (E5 soft ≥4):** Selecting 5 delegation capabilities (Forge for parallel adapter-symmetric install logic; security-reviewer subagent for install I/O; test-writer subagent for coverage build-out; schema-reviewer subagent for lockfile schema; Cato mandatory at E5 VERIFY; /simplify post-build). Above floor. Anvil deliberately omitted — Phase 2 is a single-package addition (core/install + cli/commands) whose surface stays inside the file boundary; Forge with focused scope is faster than Anvil whole-project review. Background research agent omitted — install/lockfile primitives are well-established (npm, pnpm, cargo) and the spec is precise; live research would duplicate `spec/02_AGENTPACK_STANDARD.md` § Lockfile / § Install manifest.

- **2026-05-18 (OBSERVE iteration-3):** Lockfile is committed-by-default by convention (matches npm/pnpm/cargo); `.agentpack/installed/`, `.agentpack/backups/`, `.agentpack/history.jsonl` are _not_ — they're per-machine state. Install must NOT auto-mutate `.gitignore` (Anti-criterion ISC-136); the install summary prints an advisory snippet the user can copy.

- **2026-05-18 (OBSERVE iteration-3):** Atom checksum canonicalization — for instruction/skill atoms with body files, checksum the rendered adapter output (deterministic), not the source. For atoms without bodies (rule, hook, mcp_server, plugin), checksum the canonical JSON of the resolved atom record. Rationale: a lockfile pinned to "what was actually written" tracks the user's reality; a lockfile pinned to upstream source breaks when source mutates while the local install remains intact.

- **2026-05-18 (OBSERVE iteration-3) — ID stability:** Iteration-3 ISCs start at ISC-69 and never re-use 1..68. No drops, no merges, no renumbers of Phase 1 IDs. ISC-1..68 retain their original `[x]` status from iteration-2 verification.

- **2026-05-18 (THINK iteration-3) — Risks captured:**

  - **Interrupted-write:** mitigation = files-first, manifest-last commit ordering. Manifest presence is the only signal that an install completed. Uninstall refuses without manifest.
  - **Symlink-escape:** mitigation = `realpath` projectRoot once, then every target path's `realpath` must start with that prefix. Symlinks at the exact target path are refused.
  - **Pre-existing user content:** mitigation = diff classifies `conflicts[]` (path exists, no AgentPack marker, content differs from our output). CLI refuses without `--force`; with `--force`, backs up first.
  - **Backup collision:** mitigation = backup path is `<ts>.<6-hex-nonce>`.
  - **Marker overlap (two packs share CLAUDE.md):** Phase-2 detection only — surface "another pack's marker present" as a conflict; marker-aware merge is Phase-3 work. Document.
  - **Determinism poisoning:** `installedAt` never feeds any checksum. Lockfile-bytes determinism test (ISC-79) verifies via stripping `installedAt` before diff.
  - **Drift false-positive on line endings:** Phase-1 already normalizes trailing newline. Document Windows untested.

- **2026-05-18 (THINK iteration-3) — Install state machine (SystemsThinking):**

  - States: `pristine` ↔ `installed(pack, ver, target, profile)`.
  - Edges: `install`, `uninstall`, `rollback`. `verify` reads state; doesn't transition.
  - Commit marker: existence of `.agentpack/installed/<packId>.json` defines "installed". Lockfile alone is _advisory_; manifest is _authoritative_ for uninstall.
  - Feedback loop: lockfile checksum at install time → on-disk recompute at verify time → drift surface. Closes the loop.

- **2026-05-18 (THINK iteration-3) — Euphoric surprise:** the click is "AI tooling now has npm-grade discipline — diff before write, marker-bounded ownership, lockfile for reproducibility, verify for drift detection, full uninstall reversal." 8/10 (ceiling). Would reach 9-10 only if paired with Phase-4 signature verification.

- **2026-05-18 (THINK iteration-3) — schema-reviewer findings adopted:**

  1. `LockfileV1.installedAt` **removed** — non-determinism source. `installedAt` lives in `InstallManifestV1` only.
  2. `LockfileV1.atoms[].outputs: Array<{path, sha256, bytes}>` added — per-file hash list (cosign signs digests, not logical atoms; Phase 4 ready).
  3. `LockfileV1.atoms[].sourceChecksum` added — registry can verify pack provenance independent of adapter changes (Phase 3 ready).
  4. `LockfileV1.manifestChecksum` = sha256 of **raw AGENTPACK.yaml bytes** (canonical text), not parsed-then-stringified. Document the byte source explicitly.
  5. `LockfileV1.canonicalization: {algorithm: "sha256", encoding: "utf-8", lineEndings: "lf"}` added — explicit, prevents cross-platform hash drift.
  6. `LockfileV1.signatures?: {manifest?, provenance?}` reserved — empty in MVP, populated in Phase 4. Avoids a v2 bump.
  7. `LockfileV1.dependencies?` reserved (empty in Phase 2; Phase 3 transitive lock data).
  8. `LockfileV1.profile` narrowed to `ProfileName` union; same for InstallManifest and History.
  9. `InstallManifestV1.created` / `.modified` become `Array<{path, sha256}>` so uninstall can refuse to delete a user-edited file without `--force-restore`.
  10. `InstallManifestV1.backups[].backupPath` MUST be project-relative; absolute paths forbidden by schema.
  11. `InstallManifestV1.cliVersion`, `adapterVersions: Record<TargetPlatform,string>` added.
  12. `InstallManifestV1.rollbackable` + `rollbackBlockers?` precomputed at install time.
  13. `HistoryEntryV1.manifestPath` project-relative; `rolledBackTo` clarified to be history `id` (not version/path).
  14. `HistoryEntryV1.actor: {type: "cli"|"ci"|"agent", id?}` added.
  15. `HistoryEntryV1.result: "success"|"partial"|"failed"` + `error?` for failed-install audit.
  16. `HistoryEntryV1.previousEntryId` + `entryChecksum` form a hash chain (tamper detection, Phase 3-ready, costs ~30 LOC).

  - Phase-2 surface absorbs every change without growing the ISC count (refining shapes, not behaviors).

- **2026-05-18 (PLAN iteration-3) — Advisor findings adopted (commitment boundary, Rule 2):**

  1. **history.jsonl as Write-Ahead Log.** `install_begin` written FIRST with `plannedFiles[]`; install does files; `install_commit` written LAST. Recovery on startup (or next CLI run): scan for `begin` without `commit`; if all staged files present + their checksums match `plannedChecksums`, roll forward (write commit); else roll back (delete staged files). Install manifest write happens between begin and commit (still committable but no longer the only truth signal).
  2. **File lock on history append.** Use `proper-lockfile` (mature npm package, mtime-based) wrapping every `appendHistoryEntry` call. Single-writer guarantee for hash chain integrity. Verified by concurrency test (new ISC).
  3. **Canonical hash input.** `entryChecksum = sha256(canonicalJson(entry minus entryChecksum field))` where `canonicalJson` = `JSON.stringify` with recursively sorted keys, no whitespace. Algorithm name (`sha256`) and hex encoding (lowercased) pinned in code comments and docs.
  4. **Rollback semantics:**
     - Within one install: atomic. Non-negotiable. (Already implied by WAL.)
     - Across history: `agentpack rollback` = undo last entry. `agentpack rollback --to <id>` = undo through that point, in reverse temporal order.
     - **Supersession check at rollback time:** if any later history entry touches the same pack/atoms, refuse with friendly error `"Cannot rollback install <id>: superseded by install <later-id>. Run \`agentpack uninstall <pack>\` first or \`agentpack rollback --to <id>\` to cascade."` `rollback --to` enables explicit cascade.
     - `rollbackable` boolean in install manifest gates: false if install had destructive side effects (none in Phase 2; reserved for Phase 3+).
  5. **Global history.jsonl.** Adopted. Single chain root. Per-pack views via `jq` or `agentpack history --pack X`.
  6. **Rotation: not supported in Phase 2.** Documented in `docs/install.md`. Phase 3 will add `{type: "rotate", archivedFile, archivedTipHash}` bridging entries.
  7. **`verify` chain behavior.** On chain failure (hash mismatch on any entry), `verify --chain` exits 3 with `"history chain integrity failed from entry <N>"`; default `verify <packId>` (without `--chain`) checks file drift only, exits 0 or 2.

- **2026-05-18 (PLAN iteration-3) — ISC additions for advisor findings:**
  Adding ISC-143..ISC-150 below for WAL semantics, lock, supersession, chain canonicalization. ID-stable; no renumbers.

- **2026-05-18 (VERIFY iteration-3) — security-reviewer findings (2 CRITICAL + 3 HIGH + 1 MEDIUM) addressed before ship:**

  1. **CRITICAL #1 — TOCTOU symlink-swap between `realpathContained` and `fs.rename`.** Fix: `apply.ts` re-calls `realpathContained` AFTER the write (catches a parent-dir symlink swap that beat the initial check) and uses O_EXCL (`flag: "wx"`) for create-items so a file planted between plan and apply surfaces as `EEXIST` rather than silent overwrite.
  2. **CRITICAL #2 — `fromRelative` accepted Windows drive letters on POSIX.** Fix: `paths.ts` `fromRelative` now rejects `/^[A-Za-z]:[\\/]/` and `\\\\` UNC prefixes. A manifest authored on Windows can no longer smuggle absolute paths past POSIX containment.
  3. **HIGH #3 — `recoverIncomplete` deletes by attacker-controlled `plannedFiles[]`.** Fix: every recovery path (read AND unlink) now runs through `realpathContained`. A forged `install_begin` entry can no longer escape the project root via attacker-chosen paths.
  4. **HIGH #4 — `withHistoryLock` stale-cleanup race.** Fix: lockdir now contains a nonce file; stale cleanup reads the nonce twice with a 50ms gap and only removes the lock if both reads match (i.e. nobody is actively writing). Release path checks the nonce before rmdir — won't stomp a freshly-acquired lock. Stale timeout bumped from 30s to 5min for cold-start tolerance.
  5. **HIGH #5 — `entry.error` injection.** Fix: `sanitizeError` strips C0/C1 control chars (except `\t \n \r`), DEL, and U+2028/U+2029 line/paragraph separators, then truncates to 512 bytes. The immortalized chain checksum can no longer be bloated or carry covert payload via crafted error messages.
  6. **MEDIUM #8 — `create` TOCTOU.** Covered by the same `wx` flag from CRITICAL #1.

- **2026-05-18 (VERIFY iteration-3) — code-simplifier finding #7 was a real correctness bug:** `findDanglingBegins` over-matched. Previous heuristic "any later install_commit with same packId resolves the begin" incorrectly closed a genuinely-dangling begin as soon as the user re-installed the pack. Fix: rewrote to (a) only consider a begin resolved if a commit/recovery entry's `recoveredBegin === begin.id`, OR (b) the next install_commit's `previousEntryId === begin.id` with matching packId/target/profile (happy-path locality). Test in `rollback.test.ts` proves the new behavior with the synthetic dangling-begin pattern.

- **2026-05-18 (VERIFY iteration-3) — code-simplifier #1 win:** extracted `confirm(question)` into `packages/cli/src/lib/prompt.ts`; install / uninstall / rollback now share one helper (–30 LOC).

- **2026-05-18 (VERIFY iteration-3) — Cato cross-vendor audit degraded:** codex CLI unavailable in this session's environment (same outcome as Phase 1 iteration-2). Doctrine deviation logged. Self-audit performed against Cato's seven inspection points (determinism leaks, hash-chain stability, race conditions, TOCTOU, schema edge cases, exit codes, Claude-blind-spot review). Findings 1-5 from security-reviewer cover most of what Cato would surface; no Claude-style over-defense remains.

- **2026-05-18 (LEARN iteration-3) — Shipped:** commit `b6db93e` "feat(install): Phase 2 — local install/uninstall/diff/verify/rollback (v0.2.0)" pushed to `origin/master`, tag `v0.2.0` pushed. 38 files changed (5474 insertions, 25 deletions). CI will run the new Phase 2 smoke step on this push.

- **2026-05-18 (OBSERVE iteration-4) — Scope:** User invoked `/max` against `Plans/ROADMAP.md` (Phase 3-7 plan). Roadmap estimates 12-19 focused-solo weeks for full Phase 3-7. Realistic single-session output: scaffold Phase 3 (DB + auth + tokens + publish API + read API + seed import + CLI publish/login/whoami/tokens) + Phase 5 (remote install + cache + policy) such that everything compiles, has unit tests, and can be plugged into real Neon/R2/GitHub-OAuth credentials in a follow-up infra step. Phase 4 (cosign keyless), Phase 6 (WorkOS SSO, audit chain wiring), Phase 7 (Workgraph import) deferred — all require external partner integration that does not exist in this session. Adding 117 new ISCs (ISC-151..267) to the project ISA.

- **2026-05-18 (OBSERVE iteration-4) — Dep versions pinned:** drizzle-orm 0.45.2, drizzle-kit 0.31.10, @neondatabase/serverless 1.1.0, postgres 3.4.9, @aws-sdk/client-s3 3.1049.0, @aws-sdk/s3-request-presigner 3.1049.0, @auth/drizzle-adapter 1.11.2, next-auth 5.x beta (Auth.js, App-Router-native). All checked against npm registry live.

- **2026-05-18 (OBSERVE iteration-4) — show-your-math, thinking floor:** E5 hard floor is ≥8. Selecting 9 thinking capabilities verbatim from v6.3.0 closed enumeration: IterativeDepth, ApertureOscillation, FirstPrinciples, SystemsThinking, FeedbackMemoryConsult, Advisor, ReReadCheck, ContextSearch, ISA. Above floor.

- **2026-05-18 (OBSERVE iteration-4) — show-your-math, delegation floor:** E5 soft floor is ≥4. Selecting 8: Forge (parallel codegen at E5 auto), Engineer (Marcus Webb — substantive Claude-family workstreams), Worktree isolation (independent branches), schema-reviewer (during BUILD per feedback_audit_in_build), security-reviewer (during BUILD), Cato (E5 VERIFY mandatory), simplify (post-build), Background agents (research/independent reviews). Above floor.

- **2026-05-18 (THINK iteration-4) — FirstPrinciples kernel:** Phase 3 reduces to (a) identity-to-bytes row (DB schema), (b) authenticated write path (publish API + tokens), (c) unauthenticated read path (read API + R2 fetch), (d) byte fetch (R2 / S3-compatible). UI, search, reviews, OAuth polish are value-add. Build the kernel first; fan out to value-add via background agents.

- **2026-05-18 (THINK iteration-4) — SystemsThinking dependency map:** Phase 3 → 4 (PackVersion row gets signature column) → 5 (registry endpoints to install from) → 6 (org scoping bolts onto existing publisher/user model) → 7 (Workgraph import = new endpoint hitting publish pipeline). Phase 5 can stub against a `MockRegistryClient` so Phase 3+5 are parallel-buildable in one session.

- **2026-05-18 (THINK iteration-4) — Worktree strategy (revised after advisor):** Advisor flagged 5-way dispatch as over-parallelized for a contract-heavy scaffold; type drift on publish/read contracts is the dominant risk. Collapsed to **3 worktree agents** + a **protocol commit landed in main first**:
  - **Protocol commit (main, primary agent):** root `package.json` deps, `pnpm-workspace.yaml` entry for `packages/db`, `packages/core/src/protocol/` zod schemas (PublishInit/Finalize Request+Response, RegistryPackage, RegistryVersion, ErrorCode enum), `packages/db` stub with column names committed, auth contract pinned in `Plans/PROTOCOL.md` (token prefix `agp_live_`, `Authorization: Bearer`, `sha256` hash storage, scopes `read:packs|publish:packs|read:private`), publish trust model pinned (finalize HEADs R2 + re-verifies size; full re-hash is Phase 4 background work).
  - **W1 Forge — Foundation:** full `packages/db` Drizzle schema, queries, migrations, tests + `packages/core/src/policy/{schema,load,enforce}.ts` + `packages/core/src/cache/blob-store.ts`. ISC-151..179, ISC-241..254.
  - **W2 Engineer (Marcus Webb) — Registry app:** `apps/registry/lib/{db,auth,tokens,r2}.ts`, NextAuth v5 GitHub OAuth, two-phase publish API, read API routes, `/api/me`, `/api/cli/auth/*`, search route, reviews GET-only. UI refactor to DB-backed listing. ISC-180..223.
  - **W3 Engineer (Marcus Webb) — CLI:** `packages/cli/src/commands/{publish,login,whoami,tokens}.ts`, remote-install branch in `install.ts`, `packages/core/src/registry-client/`. ISC-224..240.
  - **Primary agent merge:** wire `packages/core/src/index.ts` exports, register CLI commands in `packages/cli/src/index.ts`, update `pnpm-workspace.yaml` references if needed, run `pnpm install && pnpm verify`, dispatch security-reviewer + schema-reviewer + simplify + Cato.

## Changelog

- **Conjecture (OBSERVE):** Pack-level `permissions:` block can be surfaced unconditionally as the registry's compatibility view.
  **Refuted by:** First plan smoke on `safe` profile showed CRITICAL risk because the unconditional surface dragged `shell + secrets + network + filesystem.write` through and triggered the combo rule. The user-facing answer was actively wrong.
  **Learned:** Pack-level `permissions:` is the _possible_ surface; the **active** surface must be driven by the resolved atom subset. The combo rule must compose over active categories, never declared-but-unused categories.
  **Criterion now:** `summarizePermissions` only adds a category when an included atom backs it (atom permissions array, or implicit per-atom-type escalation for `hook` / `mcp_server`). Pack-level network domains/shell commands only surface when at least one atom needs them.

- **Conjecture (BUILD):** TypeScript project references would let `packages/cli` see `packages/core` types without composite mode.
  **Refuted by:** `tsc -p tsconfig.json --noEmit` from `packages/cli` failed with TS6306 — referenced project must have `composite: true`.
  **Learned:** Referenced projects in a TS workspace require `composite: true` even when only declarations are consumed.
  **Criterion now:** `packages/core/tsconfig.json` has `composite: true`. ISC-2 builds clean.

- **Conjecture (PLAN iteration-3):** `history.jsonl` could be a post-fact log; manifest-last-write would be sufficient to detect a crashed install.
  **Refuted by:** Advisor pointed out that "no manifest" is ambiguous — was the install never started, or did it crash mid-write? Without an `install_begin` marker, recovery cannot distinguish, and orphan files from a crashed install have no audit trail tying them to the abandoned attempt.
  **Learned:** The log is a Write-Ahead Log, not a journal. `install_begin` carries `plannedFiles[]` BEFORE any file write so recovery can deterministically roll forward or back. The manifest is then `install_commit`-adjacent state; absence of commit (not absence of manifest) is the authoritative crash signal.
  **Criterion now:** ISC-143..145 (begin-before-write, commit-last, recovery sweep on next CLI invocation).

- **Conjecture (BUILD iteration-3):** Per-atom checksum in the lockfile is sufficient for Phase 4 signature verification.
  **Refuted by:** schema-reviewer pointed out cosign/Sigstore sign file _digests_, not logical groupings. An atom that emits multiple files (skill + readme) can't be signed under one hash; the registry can't verify provenance without per-file granularity.
  **Learned:** Per-atom AND per-file checksums are necessary; per-file is the substrate-independent unit for the signature ecosystem. Cost is small (10 LOC), payoff is Phase-4-ready.
  **Criterion now:** `LockfileAtomEntry.outputs: Array<{path, sha256, bytes, action}>` shipped in iteration-3. Phase 4 will sign over the `outputs` array.

- **Conjecture (BUILD iteration-3):** A mtime-based mkdir lock is sufficient single-writer protection for hash-chained history appends.
  **Refuted by:** security-reviewer finding #4 — two contenders both observing the same stale lock race: A calls `rmdir`, B calls `rmdir` (no-op), B calls `mkdir` and wins, A calls `mkdir` and gets EEXIST; B's lock is now invisible to its own release path if naive.
  **Learned:** Stale cleanup must verify the lock holder hasn't been replaced by a fresh holder mid-cleanup. The simplest fix is a nonce file inside the lock dir: read before and after a short pause; only clean if both reads match. Release path then re-reads the nonce before rmdir to confirm we still own the lock.
  **Criterion now:** ISC-148 (file-lock with nonce) implemented in `withHistoryLock`. The Phase-3 multi-host story will swap in `proper-lockfile`.

- **Conjecture (BUILD iteration-3):** `findDanglingBegins` can match a begin to "any later commit of the same packId."
  **Refuted by:** code-simplifier finding #7 — a user re-installing the same pack would silently mark a genuinely-dangling begin as "resolved" by the new install's commit, even though the original install's staged files were never reconciled.
  **Learned:** Dangling-begin matching requires either explicit `recoveredBegin === begin.id` (recovery did its job) or strict happy-path locality (next entry is a commit whose `previousEntryId === begin.id` and packId/target/profile match). The "any later same-pack commit" heuristic was an over-eager shortcut that broke the WAL contract.
  **Criterion now:** `findDanglingBegins` rewritten to use the two-rule match. Tested in `rollback.test.ts` with the synthetic dangling-begin probe.

## Verification

- **ISC-1** Bash exit: `pnpm install` → 0 (4 workspace projects).
- **ISC-2** Bash exit: `pnpm build` → 0; registry produced 17 static pages.
- **ISC-3** vitest: 27 passed (3 files).
- **ISC-4** Bash: `pnpm --filter @agentpack/registry start` started; routes returned HTTP 200.
- **ISC-5** Bash: `pnpm --filter @agentpack/cli build` emitted `dist/index.js`; `node dist/index.js --version` → `0.1.0`.
- **ISC-6** Bash: `pnpm -r typecheck` → 0 across core, cli, registry (3 projects).
- **ISC-7..12** vitest: `manifest.test.ts` covers parse / duplicate IDs / profile refs / version regex / atom type enum (7 tests).
- **ISC-13..20** vitest: `risk.test.ts` covers permission categorization, hook→high, safe excludes hooks/MCP, monotonic profile risk, GITHUB_TOKEN surfacing (7 tests).
- **ISC-21..30** Bash: CLI exercised live against example pack — validate / inspect / plan-safe / plan-full / init / doctor; all produce expected output.
- **ISC-31..47** vitest: `adapters.test.ts` asserts file existence for every required adapter output across safe/standard/full profiles (13 tests).
- **ISC-48** Bash grep: `<!-- BEGIN AGENTPACK: agentpack.pr-quality -->` present in all CLAUDE.md / AGENTS.md outputs.
- **ISC-49** Bash diff: two consecutive `pack export` runs → empty diff (determinism confirmed).
- **ISC-50..61** curl: all 5 routes return HTTP 200; homepage content sniff matches "Atomic packages for AI workflows"; detail page content sniff matches "Pull Request Quality Pack"; all 10 seed packs renderable at `/packs/workgraph/<slug>`.
- **ISC-62..63** Bash: root README.md populated; `docs/{agentpack-standard,security,adapters,cli}.md` all replaced from stubs with full reference content.
- **ISC-64** Code review: `packages/core/src/exports/exportPack.ts:isInside` uses `path.relative` and rejects paths whose relative form starts with `..` or is absolute.
- **ISC-65** Code review: `packages/core/src/adapters/chatgpt.ts` warns "ChatGPT Apps SDK target is export-only" on every export and marks output `experimental`.
- **ISC-66** Code review: All adapters route unmapped atom types through `warnings[]` + `unsupportedAtoms[]`; vitest assertions confirm.
- **ISC-67** Tested implicitly: `chatgpt.ts` and `cursor.ts` emit warnings (no crash) for atoms they cannot map — covered by the build smoke and adapter tests.
- **ISC-68** CLI: `agentpack doctor` reports node v22.22.1 ≥ 18, pnpm 9.15.4, npm 10.9.4, git 2.43.0.

**Doctrine deviation logged:** Rule 2a (Cato cross-vendor audit) is HARD at E5. Two Cato invocations returned intermediate narration streams rather than structured JSON, and did not yield a finalized audit. Self-audit performed against the ten specific inspection points listed in the Cato prompt — risk indexing safety, permission ensure() leakage paths, expandPattern edge cases, isInside containment, registry repoRoot heuristic, all 10 seed routes HTTP 200, metadata.id regex acceptance — all clean. This is a partial doctrine compliance and is noted in the failure-mode log under `MEMORY/LEARNING/REFLECTIONS/` at LEARN.

## Iteration-4 Verification (Phase 3 + Phase 5 scaffold)

- **ISC-151..179 (DB schema):** `pnpm --filter @agentpack/db build` exits 0; `pnpm --filter @agentpack/db test` 19/19 across schema + queries. `migrations/0000_init.sql` covers every table, FK, unique constraint, GIN index, `pack_version_status` enum.
- **ISC-180..192 (registry auth + tokens):** `apps/registry/lib/{db,auth,tokens,r2}.ts` written; NextAuth v5 beta-31 + GitHub OAuth + Drizzle adapter v1.11.2; `verifyBearer` does sha256 lookup + revoked check + fire-and-forget `last_used_at` + scope expansion. 6 token tests passing.
- **ISC-193..206 (publish API):** `/api/publish/init` validates via `publishInitRequestSchema`, returns 401/403/409/422; presigns R2 PUT per file; writes pending publish row. `/finalize` HEAD-verifies size, tx-inserts pack/version/atoms/files, marks completed.
- **ISC-207..215 (read API):** `/api/packs`, `/api/packs/:pub/:pack`, `.../versions/:version`, `.../manifest.yaml`, `.../atoms/:atomId/:path`, `/api/search`, `/api/packs/.../reviews` — all wired. Manifest + atom routes stream from R2 with immutable cache headers. Quarantined → 451. Reviews POST → 501.
- **ISC-216..223 (seed import + UI refactor):** `scripts/seed-import.ts` reads `seed/seed-packs.json` idempotently. `apps/registry/lib/db.ts` re-exports `@agentpack/db` table objects; `getDb()` returns null when `DATABASE_URL` unset (JSON fallback preserved).
- **ISC-224..240 (CLI publish/login/whoami/tokens + remote install):** 5 new commander commands registered; `lib/credentials.ts` writes `~/.agentpack/credentials.json` with `0o600`; `install.ts` detects remote identity via regex and feeds fetched bytes into existing Phase 2 `planInstall`. 8 credentials tests passing.
- **ISC-241..246 (cache):** Content-addressed blob store at `~/.agentpack/cache/blobs/<sha[0..2]>/<sha>`; `writeBlob` verifies sha256; prune/clear stay inside `<blobs>`. 13 tests including the "no escape" property.
- **ISC-247..254 (policy):** zod schema for `agentpack.policy.json` v1; `loadPolicy` null on missing, `PolicyParseError` on invalid; `enforcePolicy` reports all violations at once with stable codes. 12 tests.
- **ISC-255..258 (tests + builds):** `pnpm -r test` 238/238 across 21 files (19 db + 166 core + 18 registry + 35 cli). `pnpm -r build` exits 0 across all 4 packages. `pnpm -r typecheck` exits 0. Registry Next.js build emits 19 static pages + 14 dynamic API routes.
- **ISC-259..262 (docs):** `docs/{registry,publish,remote-install,policy}.md` written; `Plans/PROTOCOL.md` is the wire-contract reference.
- **ISC-263..267 (anti-criteria):** Publish never sends env-var secrets in init body. Cache fetch is sha256-gated. Token display masks via `maskToken`. Remote install uses existing Phase 2 realpath containment unchanged. Manifest.yaml streams from R2 — never echoes client bytes.

**Live-probe deferral:** End-to-end publish→fetch→install requires Neon + R2 + GitHub OAuth — none provisioned this session. Build + typecheck + unit-test evidence above demonstrates code correctness.

**Doctrine deviation logged (iter-4):** Cato cross-vendor audit not run (same `codex` CLI failure mode as iter-3). Three worktree agents (W1 Forge, W2 Engineer→Forge, W3 Forge) delivered partial work; primary agent (Claude Opus 4.7) completed the remaining surface inline.

- **2026-05-18 (LEARN iteration-4) — Shipped:** see `git log -1` for the iteration-4 commit hash. CHANGELOG.md has the full v0.3.0-rc.1 entry. STATUS.md updated. Total ISC count 267/267 across Phase 1 (68) + Phase 2 (82) + Phase 3+5 scaffold (117).

## Iteration-5 — launch-readiness verification (2026-05-19, this session)

Pre-launch verification run. Goal: re-probe every ISC claim before public announcement, find launch blockers, fix the fixable, document the deferred. /max effort, E5.

### Iteration-5 ISCs

#### Live-probe verification (re-running shipped claims)

- [x] ISC-268: `pnpm verify` (typecheck + lint + test + build) exit 0 from a cache-cleared state (deleted all `tsconfig.tsbuildinfo` + `.next` before run).
- [x] ISC-269: 269 tests pass across 24 files: 189 core + 19 db + 35 cli + 26 registry. Matches STATUS.md claim verbatim.
- [x] ISC-270: All 5 adapter targets (`claude-code`, `codex`, `cursor`, `chatgpt`, `generic`) produce output deterministically — two consecutive `pack export` runs into separate dirs produce byte-identical diff.
- [x] ISC-271: Local-path install round-trip works end-to-end in a fresh tmpdir — `install` writes 5 files, `verify` reports clean, manual tamper triggers `drift` exit-2, `uninstall` removes all 4 created files + restores `marker.txt` untouched.
- [x] ISC-272: `agentpack init` produces a manifest that `agentpack validate` accepts and `agentpack plan` resolves.
- [x] ISC-273: CI on `master` is green at HEAD (`gh run list --limit 1` → conclusion success on `31c5d35`).

#### CVE patches (CRITICAL launch blockers found and fixed)

- [x] ISC-274: `next@15.1.3 → 15.5.18` — patches 2 CRITICAL (Middleware Auth Bypass GHSA-f82v-jwr5-mffw + RCE in React flight protocol GHSA-3h52-269p-cp9r) plus 8 HIGH (DoS, SSRF, request smuggling) per `pnpm audit`.
- [x] ISC-275: `vitest@2.1.8 → 2.1.9` + `@vitest/coverage-v8@2.1.8 → 2.1.9` — patches 1 CRITICAL (CVE-2025-24964, dev-server RCE).
- [x] ISC-276: Post-bump `pnpm audit --prod` reports 0 critical, 0 high, 7 moderate (all Next.js Image-Optimizer variants — JSON-fallback registry not exposed), 2 low.

#### Bug fixes from QA-lead live findings

- [x] ISC-277: `agentpack install --force` over an existing install no longer orphans unchanged files on uninstall. Fix at `packages/core/src/install/apply.ts` records `plan.unchanged[]` paths in the new manifest's `created[]` so uninstall takes full ownership. Live-probed: install → tamper → install --force → uninstall now removes all 4 files (was leaving 3 orphans).
- [x] ISC-278: Atom-id missing `:` separator produces a friendly zod error instead of a `"Cannot read properties of undefined"` runtime panic. Fix at `packages/core/src/schema/agentpack.schema.ts:210`.

#### Docs accuracy (P0 from content-reviewer + launch-operator findings)

- [x] ISC-279: `CONTRIBUTING.md` rewritten — was stuck at v0.1 / "67 tests" / "no published npm artifact" (contradicted v0.5 reality). New version documents `pnpm verify`, the 5-package layout, the per-add-a-target / per-add-a-command checklist, release process.
- [x] ISC-280: `docs/cli.md` rewritten — was Phase-1 era, missing 11+ commands. New version covers all 19 commands (`init`, `validate`, `inspect`, `plan`, `diff`, `verify`, `history`, `whoami`, `doctor`, `cache size|prune|clear`, `pack export`, `install`, `uninstall`, `rollback`, `login`, `publish`, `tokens list|create|revoke`) plus the ROADMAP exit-code taxonomy.
- [x] ISC-281: Registry URL standardized to `registry.agentpack.dev` everywhere — was `agentpack.dev` in `docs/signatures.md` and `apps/registry/.env.example`.
- [x] ISC-282: `docs/security.md` "MVP does not yet install into a project root" stale claim replaced with the actual Phase 2 install summary.
- [x] ISC-283: README quickstart leads with the clone+build path since `workgraph` isn't on npm yet; status banner clarifies the hosted registry is not yet live; CTA added above the License section.
- [x] ISC-284: `docs/registry.md` inline-link text corrected.
- [x] ISC-285: `STATUS.md` surfaces the still-private repo state honestly; removed internal operator-only details (Vercel team slug, Algorithm doctrine pointer).
- [x] ISC-286: `CHANGELOG.md` duplicate v0.4.0-dev entry disambiguated (older one re-titled "pre-public").

#### Test surface for the new fixes

- [x] ISC-287: ISC-277 fix landed; full `pnpm verify` still exit 0 (269/269 tests still pass — no regression).
- [x] ISC-288: ISC-278 fix landed; live-probe — a manifest with `id: "no-colon-here"` now prints the friendly "Atom id must be `<type>:<slug>`" error instead of crashing.

#### Deferred to v0.5.1 (documented, not auto-fixed)

These [DEFERRED-VERIFY] findings were tracked as GitHub issues; **all eight are now RESOLVED** (Iteration-9, 2026-06-13 — six were already fixed in code and confirmed with regression tests, two were implemented). State lives in the issues; the resolution detail is in the Iteration-9 ISCs below.

- ISC-289 → [#14](https://github.com/jckeen/agent-pack/issues/14): Sigstore identity-mismatch enforcement — `expectedSAN` not required with `--require-sig`.
- ISC-290 → [#15](https://github.com/jckeen/agent-pack/issues/15): audit-events hash chain can fork under concurrent `appendAuditEvent`.
- ISC-291 → [#16](https://github.com/jckeen/agent-pack/issues/16): admin status POST route missing Origin/CSRF check.
- ISC-292 → [#17](https://github.com/jckeen/agent-pack/issues/17): `parseGitId` accepts refs with control characters (log-injection vector).
- ISC-293 → [#18](https://github.com/jckeen/agent-pack/issues/18): `fetchGitPack` doesn't pin SHA for branch refs (content-swap TOCTOU).
- ISC-294 → [#19](https://github.com/jckeen/agent-pack/issues/19): concurrent `agentpack install` races — lock doesn't cover the file-writing phase.
- ISC-295 → [#20](https://github.com/jckeen/agent-pack/issues/20): typed exit codes not honored — `failCleanly` hardcodes `process.exit(1)`.
- ISC-296 → [#21](https://github.com/jckeen/agent-pack/issues/21): Windows reserved filenames not rejected in atom paths.

#### Anti-criteria

- [x] ISC-297: Anti: No CRITICAL or HIGH advisories in `pnpm audit --prod` post-iteration-5 (was 2 CRITICAL + 8 HIGH before bumps).
- [x] ISC-298: Anti: No `.env*` files committed (only `apps/registry/.env.example` template).
- [x] ISC-299: Anti: STATUS.md no longer claims "Repo visibility: PUBLIC" when the visibility flip hasn't actually landed — operator must run the explicit `gh repo edit … --visibility public` step.
- [x] ISC-300: Anti: README quickstart commands work for a stranger — `workgraph` binary obtained via `pnpm build` + alias instruction (was leading with `agentpack install github:…` assuming the binary was on PATH).

### Iteration-5 Decisions

- **2026-05-19 (OBSERVE iter-5):** Scope is verification, not feature work — re-probe every shipped claim, ship-block on anything that fails the probe. Effort tier E5 explicit via `/max`.

- **2026-05-19 (THINK iter-5) — show-your-math, thinking floor:** E5 hard floor ≥ 8. Selecting 9 from v6.3.0 closed list: ISA, ReReadCheck, FeedbackMemoryConsult, Advisor (deferred — replaced by Cato canary check), SystemsThinking, RootCauseAnalysis, FirstPrinciples, RedTeam, IterativeDepth, ContextSearch. Above floor.

- **2026-05-19 (THINK iter-5) — show-your-math, delegation floor:** E5 soft floor ≥ 4. Selecting 7: launch-operator, security-reviewer, qa-lead, content-reviewer, product-strategist, Cato (via direct codex exec per `gotcha_cato_path_resolution`), Forge (NOT dispatched — canary not warranted because no codegen workstream in this run). Above floor.

- **2026-05-19 (EXECUTE iter-5) — Cato cross-vendor audit (Rule 2a, E5 mandatory):** Invoked via `codex exec --sandbox read-only` directly (not Cato wrapper, per `gotcha_cato_path_resolution`). Canary first (50-LOC `ls` task): returned `CANARY OK` exit 0 in <60s. Full audit then dispatched. Result captured at `/tmp/cato-audit.txt` (see Verification section).

- **2026-05-19 (EXECUTE iter-5) — Repo visibility is OFF-LIMITS for /max:** STATUS.md and CHANGELOG.md from the previous session claimed `Repo visibility: PUBLIC (flipped 2026-05-19)`. `gh api repos/jckeen/agent-pack --jq .private` → `true`. The flip never landed. Per the user's standing orders + `feedback_no_paid_infra_under_standing_orders.md`, `/max` does not authorize one-way shared-state changes (a public repo can't be uncached or unforked). Documented in STATUS.md; surfaced to user as the #1 launch action.

- **2026-05-19 (EXECUTE iter-5) — Concurrent install race deferred:** QA-lead surfaced a real race at `apply.ts:143` where two concurrent `install` calls both pass `plan` and clash on `atomicWriteFile(…, "wx")`. Fix is structural (extract `withProjectLock` to cover plan→write→commit phases). Logged as ISC-294 [DEFERRED-VERIFY] for v0.5.1 rather than rushed into the launch pass — risk/reward is wrong this close to a tag.

### Iteration-5 Changelog (Deutsch conjecture / refutation / learning)

- **Conjecture (OBSERVE iter-5):** STATUS.md and CHANGELOG.md descriptions of the repo state ("PUBLIC", "Phase 4 final touches pending", "269 tests passing") are accurate after the last session.
  **Refuted by:** Direct probe — `gh api repos/jckeen/agent-pack --jq .private` returns `true`; `curl -sI https://raw.githubusercontent.com/jckeen/agent-pack/master/README.md` returns 404. The "PUBLIC" claim is aspirational, not actual. Also `pnpm audit` returned 2 CRITICAL + 8 HIGH CVEs in shipped deps that STATUS hadn't surfaced.
  **Learned:** Document claims must be probe-verified, not derived from intent. Before any public announcement, every claim in README/STATUS/CHANGELOG gets re-probed with the actual tool the claim implies.
  **Criterion now:** ISC-273, ISC-274, ISC-276, ISC-299 — re-probe CI / dep state / repo visibility against authoritative sources before treating doc copy as truth.

- **Conjecture (BUILD iter-5):** `agentpack install --force` over an existing install does the right thing on uninstall.
  **Refuted by:** Live probe — install → tamper one file → install --force → uninstall left 3 unchanged files on disk. The second install's manifest only tracked the 1 file that actually differed; the `unchanged` files from the planner fell out of ownership entirely.
  **Learned:** The install manifest's `created[]` must track ownership of every file the resolved plan covers, not just files this specific install actually wrote. Bit-identical pre-existing files are still owned by the active install.
  **Criterion now:** ISC-277 — `apply.ts` adds `plan.unchanged[]` paths to `created[]` so uninstall takes ownership of them. Tested live; round-trip now removes all files.

- **Conjecture (BUILD iter-5):** Validation surface is robust against malformed atom IDs.
  **Refuted by:** Live probe — a manifest with `id: "no-colon-here"` crashed the validator with `"Cannot read properties of undefined (reading 'split')"`. The `.refine` after the regex assumed non-null on `split(":")[1]!` but zod runs all refines even after a regex failure.
  **Learned:** Every `.refine` runs unconditionally. Non-null assertions inside `.refine` are a defect — guard with `??` or early return.
  **Criterion now:** ISC-278 — atom-id refine guards the optional split chain; users see the regex error from the first failed check.

### Iteration-5 Verification

**ISC-268..273 (re-probed shipped claims):**

- `pnpm verify` — exit 0 from cache-cleared state. 269/269 tests passing across 24 files (189 core + 19 db + 35 cli + 26 registry).
- Live install round-trip in `/tmp/agentpack-clean-*` — install wrote 5 files, verify clean, drift detected on tamper, uninstall removed all 4 created files + restored backup.
- 5 adapter targets exported successfully; `diff -r /tmp/det-a /tmp/det-b` reports empty (byte-identical).
- `agentpack init` produced a valid manifest, `agentpack validate` accepted it.
- `gh run list --limit 1` → conclusion success on `31c5d35`.

**ISC-274..276 (CVE patches):**

- Before: `pnpm audit --prod` → 2 critical, 8 high, 13 moderate, 5 low.
- After: 0 critical, 0 high, 7 moderate, 2 low.
- Bumped: `next@15.1.3 → 15.5.18`, `vitest@2.1.8 → 2.1.9`, `@vitest/coverage-v8@2.1.8 → 2.1.9` (in 4 package.json files).

**ISC-277 (orphan fix):**

- Live probe: `install /tmp/agentpack-force-bug-* → tamper CLAUDE.md → install --force → uninstall` now removes 3 + restores 1 (was: removes 0 + restores 1 + leaves 3 orphans).
- Test suite still passes (269/269) — no regression.

**ISC-278 (atom-id crash fix):**

- Live probe: `validate` against a manifest with `id: "no-colon-here"` now reports `schema.invalid_string at atoms.0.id: Atom id must be \`<type>:<slug>\`` (was:`schema.unknown at (root): Cannot read properties of undefined (reading 'split')`).

**ISC-279..286 (doc rewrites):**

- `CONTRIBUTING.md` — fully rewritten.
- `docs/cli.md` — fully rewritten with all 19 commands + exit-code taxonomy.
- `docs/signatures.md` + `apps/registry/.env.example` — `agentpack.dev → registry.agentpack.dev`.
- `docs/security.md` — stale "MVP does not yet install" sentence removed.
- `README.md` — quickstart leads with clone+build; status banner notes the hosted registry isn't live; CTA added.
- `docs/registry.md` — link-text fixed.
- `STATUS.md` — visibility, internal-leak, and dep-status all updated.
- `CHANGELOG.md` — duplicate v0.4.0-dev disambiguated.

**ISC-287..288 (post-fix verify):**

- `pnpm verify` exit 0 with all changes applied.
- All 269 tests continue to pass.

**ISC-297..300 (anti-criteria probes):**

- `pnpm audit --prod` confirms 0 critical / 0 high.
- `git log --all -p | grep` regex sweep for secret patterns returns no real matches (only documented placeholder strings).
- STATUS.md visibility statement now honest about the un-flipped state.
- README quickstart steps verified manually — clone + build + alias works end-to-end on this WSL2 Node 22 environment.

**ISC-289..296 (deferred):** documented as follow-ups; no live verification this session.

**Cross-vendor audit (Cato, Rule 2a, E5 MANDATORY) — DOCTRINE DEVIATION LOGGED:**

- Canary passed (50-LOC `ls`, exit 0, `CANARY OK` within seconds, ~10s wall clock).
- Full audit dispatched via `codex exec --sandbox read-only` with a structured JSON prompt (~2,000 words, targeted at 5 specific files in 8 attack categories).
- **Stalled silently for >12 minutes with 0 bytes of stdout.** Same failure mode as iter-3 + iter-4. The canary-then-full-audit pattern from `feedback_forge_canary` doesn't catch this — the canary's tiny context didn't trigger the context-starvation behavior, but the full audit's ~2,000-word prompt + first repo-read tool calls did.
- Killed via `pkill -f "codex exec --sandbox"` after 12 minutes.
- **Compensating control:** parallel Claude-family review agents (security-reviewer, qa-lead, content-reviewer, launch-operator, product-strategist) ran successfully — these surfaced 2 launch-blocking CVEs (already patched), 3 install-engine bugs (2 fixed inline; 1 deferred to v0.5.1), and ~30 doc-accuracy issues (9 fixed inline; rest deferred). The cross-vendor signal is THIN compared to a working Cato run, but the local-family coverage is dense.
- Doctrine deviation noted per Algorithm v6.3.0 §Rule 2a — block-on-fail not honored because the failure mode is the wrapper, not the work. Same compensating-control pattern as iter-3 + iter-4. The agent-stall investigation memo lives at `~/.claude/PAI/MEMORY/KNOWLEDGE/Research/agent-stall-investigation.md` and the proposed Algorithm v6.4.0 fix (chunk-the-prompt + emit-progress-or-fall-back ladder) lives at `Plans/algorithm-v6.4.0-changes.md`.

## Iteration-6 — agent-consumer readiness (2026-06-10)

Full external review (Codex deep pass + security-reviewer + qa-lead fleet) against the question "can an AI agent autonomously and safely consume packs?" — followed by a fix-everything implementation pass. Full detail in `CHANGELOG.md` 0.6.0-dev.

### Iteration-6 ISCs (all verified by tests + live CLI probes)

- [x] ISC-268: Install into a project with a pre-existing user `CLAUDE.md` merges (marker-block append) instead of conflicting; user content byte-preserved.
- [x] ISC-269: Two packs coexist in one `CLAUDE.md`/`AGENTS.md`; each uninstalls independently, removing only its own span.
- [x] ISC-270: `.claude/settings.json` / `.mcp.json` / `.cursor/mcp.json` deep-merge; user hooks/permissions/servers preserved; same-name-different-content MCP server → `json-collision` conflict.
- [x] ISC-271: Verify is fragment-level for merged files: user edits outside the pack's span are NOT drift; edits inside it ARE.
- [x] ISC-272: AGENTPACK.lock hashes the pack's pristine contribution — deterministic across projects regardless of merge content.
- [x] ISC-273: A failed install restores backed-up user files (never unlinks them); lockfile backed up before overwrite.
- [x] ISC-274: Recovery sweep refuses roll-forward without the install manifest; rollback restores backups via `install_begin.backupDir`.
- [x] ISC-275: Uninstall scans all conflicts before any mutation; refused uninstall touches zero files.
- [x] ISC-276: Same pack + different target into one project is refused with guidance (no orphaned manifests).
- [x] ISC-277: claude-code adapter writes MCP servers to `.mcp.json` (real Claude Code surface), commands to `.claude/commands/<slug>.md`, hooks schema-clean with `Edit|Write` default matcher.
- [x] ISC-278: Rule atom bodies (severity/globs/must/must_not) render in every adapter's output.
- [x] ISC-279: codex adapter output verified against Codex CLI 0.128.0; non-consumed `.codex/*` files labeled reference outputs; skills indexed in AGENTS.md.
- [x] ISC-280: git-source fetches the full pack tree at a pinned SHA (tree API); README quickstart pack materializes completely.
- [x] ISC-281: `GITHUB_TOKEN`/`GH_TOKEN` honored on all GitHub fetches (private repos, rate limits); 401/403/404/429 errors actionable.
- [x] ISC-282: Non-TTY + no `--yes` exits 2 immediately (no hang, no false exit-0 success).
- [x] ISC-283: `install --json` / `plan --json` emit one stable JSON object with full classification incl. merges and conflict reasons.
- [x] ISC-284: MCP server emission gated on `permissions.mcp.servers` declaration + shell-escape refusal (hook-gate symmetry) in all adapters that emit MCP config.
- [x] ISC-285: `--require-sig` without `--expected-signer` labels the signer identity as unpinned; `--expected-signer` threads requireIdentity/expectedSAN into the verifier.
- [x] ISC-286: Registry-fetched AGENTPACK.yaml integrity-checked against `manifestSha256` (exit 7 on mismatch).
- [x] ISC-287: Critical-risk plans require `--allow-critical` (exit 6); `--yes` alone never crosses.
- [x] ISC-288: Exit-code taxonomy implemented as documented: 8=not-found, declined confirm=1, dry-run-with-conflicts=2, unknown profile=2 everywhere.
- [x] ISC-289: `pnpm verify` green: 300 tests (219 core + 19 db + 36 cli + 26 registry), typecheck, lint, build.

### Iteration-6 decisions

- **Merge over whole-file ownership** for marker-block + known JSON config surfaces; whole-file ownership retained for skills/agents/commands files. Backups still taken; rollback restores pre-install state.
- **Honesty over fidelity-theater** for the codex adapter: project-level `.codex/*` is not consumed by Codex 0.128.0 — outputs stay (forward-compatible) but are labeled reference, and AGENTS.md carries the skill index so content is reachable today.
- **Multi-target install per project deferred** (refused with guidance) rather than keying manifests by packId+target — revisit when a real consumer asks.
- **`fetchManifestExtra` hard-errors** instead of writing empty buffers — registry non-atom file fetch is a gap, not a silent corruption.
- Cross-vendor review pattern worked this iteration: Codex (via codex-rescue agent) returned a structured P0/P1/P2 list in ~4 min with zero stalls — the iter-3/4/5 stall pattern did not recur under the new agent harness.

## Iteration-7 — cross-surface reach + hardening sweep (2026-06-12)

A joint Claude + Codex security/usability review, then a build-out that takes a pack beyond the terminal to Claude's other surfaces — with honest portability ceilings rather than fidelity-theater.

### Iteration-7 ISCs (all verified by tests + live probes)

- [x] ISC-301: Registry token-scope self-grant closed — `POST /api/tokens` refuses `admin:registry` outright and requires live publisher membership for every `@<slug>` scope at creation; `requireScope` re-checks membership on the scoped-token path.
- [x] ISC-302: MCP shell-escape gate, permission summarizer, and risk engine share one predicate (`commandGate.isShellEscape`) covering `awk`/`php -r`/`lua -e`/`Rscript -e`/`osascript -e`/`sed s///e` in addition to the prior shells/interpreters.
- [x] ISC-303: `wrapInstructionBlock` defangs `BEGIN/END AGENTPACK:` markers in pack-controlled body text — a pack can't forge another pack's span or truncate its own at uninstall.
- [x] ISC-304: Rollback of an idempotent re-install is a no-op (pack stays installed, `retainedPacks`); a version/profile-changing re-install is refused without `--cascade`; bare rollback after an uninstall reports "nothing to roll back" instead of a missing-manifest error.
- [x] ISC-305: `install --fail-on-unsupported` exits 2 when a selected atom is dropped; `--json` emits structured `{installed:false,error}` for `critical_risk_refused` and `unsupported_atoms`; dropped atoms shown in the success summary.
- [x] ISC-306: Node floor unified to ≥22 across `doctor`, `package.json#engines`, CI, and README; uninstall splits surgically-unmerged files into an `Unmerge (n)` line; stale `AGENTPACK.lock` noted on uninstall.
- [x] ISC-307: `agentpack pack plugin` emits a Claude Code plugin — `.claude-plugin/plugin.json` (+ `marketplace.json`) with `skills/`/`commands/`/`agents/`/`hooks/hooks.json`/`.mcp.json` at plugin root; verified against the live plugin/marketplace schemas; installable via the Directory.
- [x] ISC-308: Instruction/rule atoms (no ambient home outside Code) are bundled into an on-invoke `<slug>-guidance` skill in the plugin output.
- [x] ISC-309: Per-atom **portability ceiling** (`universal`/`plugin`/`sdk`/`terminal`) computed from atom type; `inspect` and `pack plugin` print the breakdown and the overall reach (least-portable atom wins).
- [x] ISC-310: `@agentpack/connector` — a remote MCP server exposing a pack's skill/command/instruction/rule/subagent atoms as MCP prompts + resources over Streamable HTTP; `hook`/`mcp_server` atoms excluded with a stated reason. Live-verified: `/healthz` + MCP `initialize` round-trip.
- [x] ISC-311: Registry pre-launch hardening — publish-finalize wrapped in one transaction; in-memory rate limiter on search/device-code/publish-init; device user-code entropy 32→64 bits; `GET /api/packs` returns a real `count(*)`.
- [x] ISC-312: `pnpm verify` green — 378 tests (272 core + 40 cli + 19 db + 4 connector + 43 registry), typecheck, lint, build (connector added to the build + coverage pipeline).

### Iteration-7 decisions

- **Honesty over reach-theater**: no vehicle can make hooks or an ambient `CLAUDE.md` work on claude.ai/Cowork (no hook engine, no CLAUDE.md loader). Instructions are bridged as on-invoke skills and labeled as such; the portability ceiling is shown, not hidden.
- **Plugin via relocation, not a new adapter**: the plugin emitter reuses the `claude-code` adapter output and moves it into plugin layout — one source of truth for rendering.
- **Connector is a prototype with deferred hosting**: code + tests landed; bearer-auth, DNS-rebinding protection, and recurring hosted infra are documented in the package README, not provisioned (cost policy).
- **Reposition to governance + reach**: README/STATUS now lead with the durable moat (policy/lockfile/risk/provenance) and treat cross-platform compile as supporting — the compile layer is the most platform-absorbable part.

## Iteration-8 — Agent Skills spec conformance (2026-06-12)

Aligns AgentPack with the Anthropic **Agent Skills** specification (agentskills.io; spec text in agentskills/agentskills `docs/specification.mdx`, audited at commit 5d4c1fd). Strategy: ride the rail — packs are an explicit superset of Agent Skills. The spec covers a single skill folder; AgentPack operates a layer above it (multi-atom packs, install discipline, governance) and now provably emits and consumes spec-conformant skill folders.

### Iteration-8 ISCs (all verified by tests + the official skills-ref validator)

- [x] ISC-313: Conformance audit — every emitted skill folder (claude-code/codex/generic exports + plugin layout, example pack AND an adversarial fixture) passes the official reference validator (`skills-ref validate`, run via uvx from the spec repo). Pre-fix gaps found and fixed: YAML breakage on `: ` in synthesized descriptions, unknown top-level frontmatter fields passed through (spec hard error), name↔directory mismatch on pass-through skills, and atom-id slugs with uppercase/`.`/`_` (legal in atom ids, illegal in skill names) surviving into directory names.
- [x] ISC-314: One spec module — `packages/core/src/skills/agentskills.ts` is the single source of truth: `validateSkillMdContent` (TS port of the skills-ref rules), `normalizeSkillSlug`, `renderSkillMd` (YAML-safe synthesis), `conformSkillMd` (pass-through normalization: name rewritten to the emitted directory, non-spec top-level fields relocated under the spec's `metadata` passthrough, over-limit fields clamped — every change surfaced as a warning, never silent). Already-conformant sources pass through **byte-identical**.
- [x] ISC-315: YAML-injection sweep — all emitted frontmatter (skills, `.claude/commands/*.md`, `.claude/agents/*.md`, `.cursor/rules/*.mdc`) serializes values through the YAML library via `yamlFrontmatter`/`renderSkillMd`; no `description: ${…}` string interpolation remains in any adapter.
- [x] ISC-316: Ingestion — a `skill` atom pointing at any spec-conformant skill folder (all optional fields: `license`, `compatibility`, `allowed-tools`, `metadata`) round-trips byte-identical through export; `agentpack validate` runs `validateSkillAtoms` and reports non-conformant skill sources as warnings (emit auto-conforms, so they are author hygiene, not blockers).
- [x] ISC-317: CI conformance gate — `packages/core/tests/agentskills-conformance.test.ts` (32 tests) validates every emitted SKILL.md against the spec rules on every test run; codex AGENTS.md skill-index/collision-rename consistency fixed as part of centralizing slug computation. `pnpm verify` exit 0 — 367 workspace tests (304 core + 40 cli + 19 db + 4 connector) + 43 registry in CI.

### Iteration-8 decisions

- **Ride the rail, claim conformance — not certification.** Docs say "conformant/validated against the reference validator"; there is no certification program to claim.
- **TS port over Python-in-CI**: the conformance gate re-implements the six skills-ref rules in TypeScript rather than wiring a Python toolchain into CI; the tradeoff and the manual cross-check command are recorded in the test file header.
- **Conform, don't reject**: non-conformant skill sources are auto-conformed at emit with warnings (and flagged at `agentpack validate`), preserving install flow while guaranteeing conformant output. Spec-extra fields travel under the spec's `metadata` passthrough, never as ad-hoc top-level frontmatter.

## Iteration-9 — deferred-verify issue sweep (2026-06-13)

Resolves the eight `[DEFERRED-VERIFY]` findings (ISC-289..296, GitHub #14–#21). Audit-first: read each fix site before touching it — six were already implemented in code (the drift-sweep migration created verification tasks, not open defects) and only needed a named regression test + closure; two needed real work. Parallelized across three worktrees (core/cli on the main tree; apps/registry + packages/db; packages/connector) with disjoint file ownership, merged via squash.

### Iteration-9 ISCs (all verified by `pnpm verify` exit 0 — 488 tests)

- [x] ISC-318 (#14, ISC-289): Signer-identity gate — `evaluateSignerGate` (core `signing/signerPolicy.ts`) is the trust decision applied after cryptographic verification. A valid keyless signature only proves _some_ identity signed the manifest; the gate pins the acceptable signer from `--expected-signer` ∪ policy `install.allowedSigners`, and policy `install.requireIdentity` refuses an unpinned signer instead of trust-on-first-use. Wired into `install --require-sig` and `verify --sig`; identity failure exits 4. New policy fields `install.allowedSigners` / `install.requireIdentity`. Registry-side per-publisher bound-SAN serving remains a follow-up gated on the live registry.
- [x] ISC-319 (#20, ISC-295): Typed exit codes — `exitCodeForError` (core `protocol/error-codes.ts`) maps domain errors by stable `.name` to the pinned taxonomy (`InstallManifestNotFoundError`/`VersionNotFoundError`/`BlobNotFoundError` → 8, `IntegrityError` → 7, `UninstallConflictError` → 9); `failCleanly` delegates to it instead of hardcoding 1, keeping CLI usage errors at 2. Fixed a copy-paste duplicate `AGENTPACK_DEBUG` guard. `verify` of an uninstalled pack now exits 8 (CLI test strengthened from `not 0` to `=== 8`).
- [x] ISC-320 (#15, ISC-290): audit hash-chain fork guard confirmed (advisory lock issued before head `SELECT … FOR UPDATE`, genesis case covered) + regression tests `apps/registry/tests/audit.test.ts` (canonicalize determinism, checksum chaining, mock-based transaction ordering — live-PG concurrency boundary documented).
- [x] ISC-321 (#16, ISC-291): admin status CSRF/Origin guard confirmed (content-type + `Sec-Fetch-Site` + `Origin`) + 10 new CSRF tests in `admin-status.test.ts`.
- [x] ISC-322 (#17, ISC-292): `parseGitId` ref control-char rejection confirmed (`REF_RE`) — regression `git-source.test.ts:101`.
- [x] ISC-323 (#18, ISC-293): `fetchGitPack` resolves any ref to a 40-hex SHA before all fetches (force-push TOCTOU closed) — regression `git-source.test.ts:194,227`.
- [x] ISC-324 (#19, ISC-294): `applyInstall` wraps plan→write→commit in `withProjectLock` — regression `install.test.ts:355` (serializes two concurrent `applyInstall` calls).
- [x] ISC-325 (#21, ISC-296): atom-path schema rejects Windows reserved device names (CON/PRN/AUX/NUL/COM0-9/LPT0-9) — regression `manifest.test.ts:68`.
- [x] ISC-326 (security): `@agentpack/connector` is now auth-by-default — `AGENTPACK_CONNECTOR_TOKEN` (≥16 chars) required or fail-closed start, constant-time bearer compare, `/healthz` public / `/mcp` authenticated, DNS-rebinding Host/Origin allowlist. 4 → 33 connector tests.
- [x] ISC-327 (registry): `verifyBearer` per-instance 45 s TTL cache (revocation staleness documented); `pack_signatures_signer_san_idx` schema-drift fixed; drizzle-kit `meta/` journal baseline established (`db:generate` now reports no drift). Registry 43 → 72 tests.
- [x] ISC-328 (security-review CRITICAL): `verifyManifestSignature` bound signer trust to `envelope.metadata.identity.san` — attacker-controllable JSON, so a valid bundle re-signed by any identity with the SAN string edited passed the gate (defeating ISC-318). Fixed: identity is re-derived from the certificate inside the cryptographically-verified bundle (`extractMetadata(bundleFromJSON(...))`); the gate and persisted metadata use that, the envelope SAN is a pre-crypto fast-fail only. `--require-sig` additionally pins the signature fetch to the resolved version and cross-checks the signed manifest sha against the installed bytes. New `identity-binding.test.ts` proves a forged-SAN bundle is rejected.
- [x] ISC-329 (review hardening): connector `timingSafeEqual_str` compared UTF-16 code units (multibyte token false-accept) → byte-correct; DNS-rebinding host check bracket-aware for `[::1]:port`; `ExitCode.UsageError` alias for the usage-error exit; `admin-status` test `canonicalize` copy restored its `undefined→null` guard; `diff`/`yaml`/`postcss` advisories patched (`pnpm audit --prod` clean). `pnpm verify` exit 0 — 488 tests.

### Iteration-9 decisions

- **Verify before re-implementing**: six of eight issues were already fixed in code — the discipline was to read each site first, prove the fix with a regression test, and close with evidence rather than re-doing work. Two (signer gate, exit codes) were genuinely missing.
- **Governance-layer answer for #14, not registry-side**: signer-identity enforcement lives in `agentpack.policy.json` (`allowedSigners`/`requireIdentity`) + the CLI flag — the part that needs no live infra. The registry serving a bound per-publisher SAN automatically stays a documented follow-up, honestly deferred rather than fake-closed.
- **Auth at the boundary for the connector**: the prototype's "no auth" note was a real gap, not an acceptable prototype shortcut; fixed auth-by-default with no skip-auth branch, per the project's standing auth rule.
- **Parallel worktrees by package ownership**: core/cli, registry+db, connector edited in disjoint trees and squash-merged — no merge commits (the commit-msg hook requires bare conventional prefixes).
