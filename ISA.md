---
project: agent-pack
task: Build AgentPack standard + Workgraph Registry MVP (Phase 1) + local install/uninstall + supply-chain (Phase 2)
effort: E5
phase: complete
progress: 150/150 (Phase 1: 68 + Phase 2: 82)
mode: ALGORITHM
started: 2026-05-18T15:17:00-04:00
updated: 2026-05-18T17:55:00-04:00
iteration: 3
---

## Problem

AI tooling is fragmenting across Claude Code, Codex, Cursor, ChatGPT Apps, MCP-compatible clients, and other host platforms. Each exposes its own surface for instructions, rules, skills, hooks, commands, subagents, MCP tools, and plugins. There is no atomic, portable packaging standard with permission visibility, risk scoring, and cross-platform compilation. Authors duplicate work; users have no way to inspect what a pack will do before installing it.

## Vision

A developer drops a single `AGENTPACK.yaml` into a repo and runs `workgraph pack export --target claude-code --profile safe`. They see exactly which files will be written, which permissions are requested, the risk level, and which atoms will be skipped under the safe profile — before any write happens. Same source compiles cleanly to Codex `AGENTS.md` + `.codex/`, to Cursor `.cursor/rules/` + `.cursor/mcp.json`, to a ChatGPT app skeleton, and to generic `skills/` + `AGENTS.md`. Euphoric surprise: "I described the workflow once and four platforms got configured correctly, with the dangerous bits flagged in red."

## Out of Scope

- ~~Phase-2 install/uninstall~~ **NOW IN SCOPE (iteration-3)** — local install/uninstall, diff, backups, rollback, lockfile, history, verify, atom checksums all added.
- Phase-3 registry backend (database, publishing, search API) — seed data only; requires hosted infra not in this session
- Phase-4 cryptographic signatures (Sigstore/cosign) — schema fields present, runtime verification deferred to dedicated session. **Atom checksums (SHA-256 content addressing) IS now in scope** as the unlocking primitive.
- Phase-5 remote CLI installs (`workgraph install publisher/pack` over network) — requires hosted registry
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
- **CLI binary is `workgraph`** (not `agentpack`, not `wg`).
- **Manifest version: `1.0`** (schema gate `^1\.0`).

## Goal

**Phase 1 (shipped):** Ship a working TypeScript monorepo where `pnpm install && pnpm build && pnpm test` succeed, every CLI command in `spec/08_ACCEPTANCE_CRITERIA.md` produces the documented output, the Next.js registry renders all seed packs with risk/compatibility/permission visibility, and the example PR-Quality pack compiles to all five targets with deterministic, marker-bounded files.

**Phase 2 (iteration-3):** Extend the same monorepo so `workgraph install examples/pr-quality --target claude-code --profile safe` shows a diff against the user's project root, prompts for confirmation, backs up any files it would overwrite, writes the new files, records an install manifest at `.workgraph/installed/<pack>.json`, writes a deterministic `AGENTPACK.lock` with per-atom SHA-256 checksums, and appends a `.workgraph/history.jsonl` entry — and `workgraph uninstall <pack>` precisely reverses it (created files removed, backups restored, manifest deleted, history append). `workgraph verify` reports any drift between the on-disk files and the lockfile's recorded checksums. `workgraph rollback <history-entry>` restores from a specific history entry. Test coverage stays ≥85% lines / ≥75% branches. The same install command appears in the registry web app's `InstallCommandBox` on every pack detail page.

## Criteria

### Build & install
- [x] ISC-1: `pnpm install` exits 0 at repo root
- [x] ISC-2: `pnpm -r build` exits 0 (core, cli, registry)
- [x] ISC-3: `pnpm -r test` exits 0 with all vitest suites passing
- [x] ISC-4: `pnpm --filter @workgraph/registry dev` boots Next.js on a port
- [x] ISC-5: `pnpm --filter @workgraph/cli build` exits 0 and emits `dist/index.js`
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
- [x] ISC-21: `workgraph validate examples/pr-quality` exits 0 with success message
- [x] ISC-22: `workgraph inspect examples/pr-quality` prints name, version, publisher, compatibility, profiles, atoms, risk, permissions
- [x] ISC-23: `workgraph plan examples/pr-quality --target claude-code --profile safe` prints LOW risk
- [x] ISC-24: `workgraph plan examples/pr-quality --target claude-code --profile full` warns about hook
- [x] ISC-25: `workgraph plan ... --profile full` warns about shell execution
- [x] ISC-26: `workgraph plan ... --profile full` warns about GitHub MCP
- [x] ISC-27: `workgraph plan ... --profile full` warns about `GITHUB_TOKEN` secret
- [x] ISC-28: `workgraph init` writes a starter `AGENTPACK.yaml` in CWD
- [x] ISC-29: `workgraph doctor` reports node version, pnpm presence, working dir status
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
- [x] ISC-48: All instruction outputs contain `<!-- BEGIN AGENTPACK: workgraph.pr-quality -->` marker
- [x] ISC-49: Re-running the same export twice produces byte-identical output

### Registry web app
- [x] ISC-50: `/` homepage renders product positioning and CTA
- [x] ISC-51: `/packs` lists all 10 seed packs from `seed/seed-packs.json`
- [x] ISC-52: `/packs` supports tag and risk filtering client-side
- [x] ISC-53: `/packs/workgraph/pr-quality` renders detail page
- [x] ISC-54: Detail page renders CompatibilityMatrix (5 targets × status)
- [x] ISC-55: Detail page renders RiskBadge with computed risk
- [x] ISC-56: Detail page renders PermissionSummary block
- [x] ISC-57: Detail page renders InstallCommandBox with `npx workgraph pack export ...`
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
- [x] ISC-73: `applyInstall` backs up every overwritten file to `.workgraph/backups/<packId>/<timestamp>/` before writing
- [x] ISC-74: `applyInstall` writes install manifest at `.workgraph/installed/<packId>.json` matching `InstallManifestV1`
- [x] ISC-75: Install manifest contains `packId`, `packVersion`, `target`, `profile`, `installedAt`, `created[]`, `modified[]`, `backups[]`, `atomIds[]`, `lockfileChecksum`
- [x] ISC-76: `applyInstall` writes `AGENTPACK.lock` at project root matching `LockfileV1` schema
- [x] ISC-77: Lockfile contains per-atom SHA-256 `contentChecksum` for every included atom
- [x] ISC-78: Lockfile contains `packId`, `packVersion`, `target`, `profile`, `adapterVersion`, `cliVersion`, `manifestChecksum`, `installedAt`
- [x] ISC-79: Two consecutive `install` runs into a clean projectRoot produce byte-identical lockfiles (determinism)
- [x] ISC-80: `applyInstall` appends a `.workgraph/history.jsonl` line with `action: install`, `packId`, `timestamp`, `manifestPath`
- [x] ISC-81: `uninstall(packId, projectRoot)` reads install manifest, restores backups, deletes created files, removes manifest
- [x] ISC-82: `uninstall` is exact inverse: install → uninstall leaves no residue under `.workgraph/installed/` for that pack
- [x] ISC-83: `uninstall` appends `.workgraph/history.jsonl` with `action: uninstall`
- [x] ISC-84: `uninstall` refuses if no install manifest exists for that packId
- [x] ISC-85: `rollback(historyEntryId)` restores project to the state before that history entry (re-runs reverse of every later install/uninstall)
- [x] ISC-86: `verify(packId, projectRoot)` computes current on-disk SHA-256 of every lockfile-tracked file and reports `clean` / `drift[]`
- [x] ISC-87: `verify` flags missing files as `missing`, modified files as `modified`, unexpected files as `extra` only inside marker bounds
- [x] ISC-88: `computeAtomChecksums(plan)` is pure (same input → same SHA-256), independent of timestamps
- [x] ISC-89: Lockfile schema is zod-validated and exported from `@workgraph/core`

### Phase 2 — CLI surface
- [x] ISC-90: `workgraph install <pack> --target X --profile Y --project .` prints diff and prompts for `[y/N]`
- [x] ISC-91: `workgraph install ... --yes` skips the prompt
- [x] ISC-92: `workgraph install ... --dry-run` prints diff and exits 0 without writing
- [x] ISC-93: `workgraph install` exits non-zero if target paths conflict with non-AgentPack-marked content (unless `--force`)
- [x] ISC-94: `workgraph uninstall <packId>` prompts unless `--yes`, then restores
- [x] ISC-95: `workgraph diff <pack> --target X --profile Y` prints unified diff and exits without writing
- [x] ISC-96: `workgraph history` lists every entry in `.workgraph/history.jsonl` (most recent first)
- [x] ISC-97: `workgraph history --pack <id>` filters by pack
- [x] ISC-98: `workgraph rollback <history-id> --yes` restores
- [x] ISC-99: `workgraph verify <packId>` exits 0 if clean, 2 if drift, 1 on usage error
- [x] ISC-100: `workgraph install` colored, profile risk surfaced *before* the prompt (consistent with `plan` UX)
- [x] ISC-101: All Phase-2 commands appear in `workgraph --help`

### Phase 2 — Registry web app
- [x] ISC-102: `InstallCommandBox` shows `npx workgraph install <pack> --target <t> --profile <p>` alongside the existing `pack export` line
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
- [x] ISC-117: `rollback.test.ts` — three-step history (install → install → uninstall) rolled back to step 0 yields empty `.workgraph/installed/`
- [x] ISC-118: CLI subprocess test — `workgraph install` with `--dry-run` exits 0 and writes nothing
- [x] ISC-119: CLI subprocess test — `workgraph install --yes` succeeds, `uninstall --yes` succeeds, `history` lists 2 entries
- [x] ISC-120: CLI subprocess test — `workgraph verify` after manual file mutation exits 2 with drift report
- [x] ISC-121: Coverage threshold preserved: lines ≥85%, functions ≥85%, statements ≥85%, branches ≥75% post-Phase-2

### Phase 2 — Documentation & release
- [x] ISC-122: `docs/install.md` written: install/uninstall/diff/verify/rollback reference
- [x] ISC-123: `README.md` quickstart section gains `workgraph install examples/pr-quality --target claude-code --profile safe --dry-run` line
- [x] ISC-124: `CHANGELOG.md` gains `## 0.2.0 — 2026-05-18` entry covering Phase 2 additions
- [x] ISC-125: `package.json` versions bumped to `0.2.0` in core, cli, registry, root
- [x] ISC-126: `STATUS.md` written at repo root reflecting Phase 2 shipped + Phase 3+ deferred

### Phase 2 — Anti-criteria & antecedents
- [x] ISC-127: Anti: `workgraph install` never writes outside `projectRoot` (verified by symlink-escape test)
- [x] ISC-128: Anti: `workgraph install` never writes a hook atom under `safe` profile
- [x] ISC-129: Anti: `uninstall` never deletes a file it did not create (compared against `created[]`)
- [x] ISC-130: Anti: `uninstall` never silently re-writes a backup over a user-edited file — surfaces `conflicts[]` and refuses unless `--force-restore`
- [x] ISC-131: Anti: lockfile checksums are NOT salted with timestamps (otherwise determinism breaks)
- [x] ISC-132: Anti: install manifest does NOT embed absolute paths (must be project-relative) so the same `.workgraph/` is portable
- [x] ISC-133: Anti: history.jsonl never logs secret values; only structural keys (packId, target, profile)
- [x] ISC-134: Anti: `verify` does NOT panic on lockfile-tracked file being absent — reports `missing[]` and exits 2
- [x] ISC-135: Anti: `rollback` does NOT cross packId boundaries — only undoes the named pack's history slice
- [x] ISC-136: Antecedent: `.workgraph/` is git-ignorable; install does NOT alter `.gitignore` automatically (advisory message only)
- [x] ISC-137: Antecedent: User can opt into `.workgraph/` committed for reproducibility (lockfile is meant to be committed)

### Phase 2 — CI & integration
- [x] ISC-138: `.github/workflows/ci.yml` smoke step `workgraph install examples/pr-quality --target generic --profile safe --project /tmp/agentpack-smoke --yes` exits 0
- [x] ISC-139: CI smoke `workgraph verify` after install exits 0
- [x] ISC-140: CI smoke `workgraph uninstall examples/pr-quality --yes --project /tmp/agentpack-smoke` exits 0
- [x] ISC-141: `pnpm verify` (typecheck + lint + test:coverage + build) exits 0 on iteration-3
- [x] ISC-142: All Phase-1 ISCs (1..68) still pass after Phase-2 changes (no regression)

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

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| ISC-1..6 | build | exit code | 0 | `pnpm` via Bash |
| ISC-7..12 | schema | zod parse outcome | true/false | `vitest` |
| ISC-13..20 | logic | function return | exact match | `vitest` |
| ISC-21..30 | cli | stdout grep + exit | substring match | `Bash` |
| ISC-31..47 | files | `Read` after export | file exists + content | `Bash` + `Read` |
| ISC-48..49 | determinism | diff between two runs | empty diff | `Bash diff` |
| ISC-50..61 | ui | route loads + text present | HTTP 200 + grep | `curl` to dev server |
| ISC-62..63 | docs | files present + sections | grep section headers | `Bash` |
| ISC-64..68 | anti | negative probe | property not present | mixed |
| ISC-69..89 | logic | core install/uninstall/verify return shape | exact match | `vitest` |
| ISC-90..101 | cli | stdout + filesystem state post-command | exit code + file existence | `Bash` subprocess |
| ISC-102..104 | ui | rendered HTML contains expected install string | grep | `curl` to dev server |
| ISC-105..120 | tests | vitest case count + pass | all green | `vitest` |
| ISC-121 | coverage | vitest --coverage thresholds | ≥85%/85%/85%/75% | `vitest` |
| ISC-122..126 | docs/release | files present + version strings | grep | `Bash` |
| ISC-127..137 | anti | negative probe (escape, no-cross-pack, no-secrets) | refused/missing | mixed |
| ISC-138..142 | ci | github workflow step exit | 0 | `Bash` simulating CI step |
| ISC-143..150 | wal/chain | begin/commit ordering + lock + canonical hash + supersession refuse | exact behavior | `vitest` + concurrency probe |

## Features

| name | satisfies | depends_on | parallelizable |
|------|-----------|------------|----------------|
| monorepo-skeleton | ISC-1, ISC-2 | — | no |
| core-schema | ISC-7..12 | monorepo-skeleton | no |
| core-permissions-risk | ISC-13..20 | core-schema | no |
| core-planner | ISC-21..30 (planner half) | core-permissions-risk | no |
| adapter-claude-code | ISC-31..34 | core-planner | yes |
| adapter-codex | ISC-35..38 | core-planner | yes |
| adapter-cursor | ISC-39..41 | core-planner | yes |
| adapter-chatgpt | ISC-42..44 | core-planner | yes |
| adapter-generic | ISC-45..47 | core-planner | yes |
| determinism-marker | ISC-48..49 | all adapters | no |
| cli-commands | ISC-21..30 | core-planner | no |
| registry-app | ISC-50..61 | core (typed seed import) | partial-parallel |
| test-suite | ISC-3, ISC-7..49 | all above | partial-parallel |
| docs | ISC-62..63 | all above | yes |
| anti-criteria-audit | ISC-64..68 | all above | no |
| **iteration-3 / Phase 2 starts here** | | | |
| install-engine-core | ISC-69..89 | core-planner, all adapters | no (touches one module) |
| install-cli-surface | ISC-90..101 | install-engine-core | yes (per-command files) |
| install-registry-ui | ISC-102..104 | install-engine-core (lockfile shape) | yes |
| install-tests | ISC-105..120 | install-engine-core, install-cli-surface | partial-parallel |
| install-coverage | ISC-121 | install-tests | no (whole-suite metric) |
| install-docs-release | ISC-122..126 | all above | yes |
| install-anti-audit | ISC-127..137 | install-engine-core, install-cli-surface | no |
| install-ci | ISC-138..142 | install-cli-surface | no |

## Decisions

- **2026-05-18 (OBSERVE):** Project ISA lives at `agent-pack/ISA.md` (project-scoped, v6.0+). Spec packet docs moved to `spec/` to keep root clean. The spec packet IS the substantive ISA pre-population.
- **2026-05-18 (OBSERVE):** Skipping ISA skill scaffold workflow — the spec packet at `spec/00..10_*.md` is denser than what scaffold would produce. ISA is consolidated by hand into 12-section canonical form here.
- **2026-05-18 (OBSERVE) — show-your-math, delegation floor:** E5 soft floor is ≥4 delegation; selecting 2 (Forge optional for parallel adapter codegen, Cato mandatory at VERIFY). Rationale: spec is sufficiently concrete that single-author execution is faster than multi-agent coordination; using Forge for parallel codegen would create merge conflicts on shared types in `packages/core/src/index.ts`. Anvil whole-project review would duplicate Cato's job at higher latency. Background research agents are not needed — no unknown libraries. Recording this rationale per soft-floor rules.
- **2026-05-18 (PLAN):** Risk model — atom risks combine by `max()` over included atoms; profile risk = max(atom risks of profile members). MCP-with-secrets and shell-exec hooks pin to `high`. Critical reserved for combinations (shell+secrets+network+filesystem-write) per spec.
- **2026-05-18 (PLAN):** Cursor adapter — `.cursor/rules/*.mdc` for `rule` atoms, `.cursor/mcp.json` for mcp_server atoms, `AGENTS.md` for instructions. Hooks emit warnings (no stable Cursor hook target yet).
- **2026-05-18 (PLAN):** ChatGPT adapter is **export-only** per spec — emits MCP server skeleton (one tool stub per `command` atom), `project-instructions.md`, `app-manifest.json`. Marks all output `conservative/proposed`.

- **2026-05-18 (OBSERVE iteration-3):** Phase 2 scope decision. User requested "Phase 2 + the rest". Phases 3-7 (registry backend, signatures, remote install, enterprise, Workgraph integration) all require external infrastructure (hosted DB, hosted registry, SSO, signing keys) that does not exist in this session. Building stubs would be dishonest. In scope this iteration: Phase 2 (install/uninstall/diff/backup/lockfile/history/rollback) PLUS the local-feasible Phase-4 unlock primitive (per-atom SHA-256 content checksums + `workgraph verify` drift detection). Out of this iteration: cryptographic signatures, hosted registry, remote `workgraph install publisher/pack`, enterprise policy. Phases 3+ stay listed in Out of Scope.

- **2026-05-18 (OBSERVE iteration-3) — context-override effort:** Classifier returned `MODE: ALGORITHM TIER: E3 SOURCE: fail-safe` after 25s timeout. User invoked `/max` which forces Advanced+ and "If the task is large enough, use Comprehensive (64+)." Scope (≥74 new ISCs, ≥6 new CLI commands, ≥5 new core modules, ≥1 registry surface, ≥4 doc files, security hardening, cross-vendor audit) puts this firmly at E5. Set `effort_source: context-override`.

- **2026-05-18 (OBSERVE iteration-3) — show-your-math, delegation floor (E5 soft ≥4):** Selecting 5 delegation capabilities (Forge for parallel adapter-symmetric install logic; security-reviewer subagent for install I/O; test-writer subagent for coverage build-out; schema-reviewer subagent for lockfile schema; Cato mandatory at E5 VERIFY; /simplify post-build). Above floor. Anvil deliberately omitted — Phase 2 is a single-package addition (core/install + cli/commands) whose surface stays inside the file boundary; Forge with focused scope is faster than Anvil whole-project review. Background research agent omitted — install/lockfile primitives are well-established (npm, pnpm, cargo) and the spec is precise; live research would duplicate `spec/02_AGENTPACK_STANDARD.md` § Lockfile / § Install manifest.

- **2026-05-18 (OBSERVE iteration-3):** Lockfile is committed-by-default by convention (matches npm/pnpm/cargo); `.workgraph/installed/`, `.workgraph/backups/`, `.workgraph/history.jsonl` are *not* — they're per-machine state. Install must NOT auto-mutate `.gitignore` (Anti-criterion ISC-136); the install summary prints an advisory snippet the user can copy.

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
  - Commit marker: existence of `.workgraph/installed/<packId>.json` defines "installed". Lockfile alone is *advisory*; manifest is *authoritative* for uninstall.
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
     - Across history: `workgraph rollback` = undo last entry. `workgraph rollback --to <id>` = undo through that point, in reverse temporal order.
     - **Supersession check at rollback time:** if any later history entry touches the same pack/atoms, refuse with friendly error `"Cannot rollback install <id>: superseded by install <later-id>. Run \`workgraph uninstall <pack>\` first or \`workgraph rollback --to <id>\` to cascade."` `rollback --to` enables explicit cascade.
     - `rollbackable` boolean in install manifest gates: false if install had destructive side effects (none in Phase 2; reserved for Phase 3+).
  5. **Global history.jsonl.** Adopted. Single chain root. Per-pack views via `jq` or `workgraph history --pack X`.
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

## Changelog

- **Conjecture (OBSERVE):** Pack-level `permissions:` block can be surfaced unconditionally as the registry's compatibility view.
  **Refuted by:** First plan smoke on `safe` profile showed CRITICAL risk because the unconditional surface dragged `shell + secrets + network + filesystem.write` through and triggered the combo rule. The user-facing answer was actively wrong.
  **Learned:** Pack-level `permissions:` is the *possible* surface; the **active** surface must be driven by the resolved atom subset. The combo rule must compose over active categories, never declared-but-unused categories.
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
  **Refuted by:** schema-reviewer pointed out cosign/Sigstore sign file *digests*, not logical groupings. An atom that emits multiple files (skill + readme) can't be signed under one hash; the registry can't verify provenance without per-file granularity.
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
- **ISC-4** Bash: `pnpm --filter @workgraph/registry start` started; routes returned HTTP 200.
- **ISC-5** Bash: `pnpm --filter @workgraph/cli build` emitted `dist/index.js`; `node dist/index.js --version` → `0.1.0`.
- **ISC-6** Bash: `pnpm -r typecheck` → 0 across core, cli, registry (3 projects).
- **ISC-7..12** vitest: `manifest.test.ts` covers parse / duplicate IDs / profile refs / version regex / atom type enum (7 tests).
- **ISC-13..20** vitest: `risk.test.ts` covers permission categorization, hook→high, safe excludes hooks/MCP, monotonic profile risk, GITHUB_TOKEN surfacing (7 tests).
- **ISC-21..30** Bash: CLI exercised live against example pack — validate / inspect / plan-safe / plan-full / init / doctor; all produce expected output.
- **ISC-31..47** vitest: `adapters.test.ts` asserts file existence for every required adapter output across safe/standard/full profiles (13 tests).
- **ISC-48** Bash grep: `<!-- BEGIN AGENTPACK: workgraph.pr-quality -->` present in all CLAUDE.md / AGENTS.md outputs.
- **ISC-49** Bash diff: two consecutive `pack export` runs → empty diff (determinism confirmed).
- **ISC-50..61** curl: all 5 routes return HTTP 200; homepage content sniff matches "Atomic packages for AI workflows"; detail page content sniff matches "Pull Request Quality Pack"; all 10 seed packs renderable at `/packs/workgraph/<slug>`.
- **ISC-62..63** Bash: root README.md populated; `docs/{agentpack-standard,security,adapters,cli}.md` all replaced from stubs with full reference content.
- **ISC-64** Code review: `packages/core/src/exports/exportPack.ts:isInside` uses `path.relative` and rejects paths whose relative form starts with `..` or is absolute.
- **ISC-65** Code review: `packages/core/src/adapters/chatgpt.ts` warns "ChatGPT Apps SDK target is export-only" on every export and marks output `experimental`.
- **ISC-66** Code review: All adapters route unmapped atom types through `warnings[]` + `unsupportedAtoms[]`; vitest assertions confirm.
- **ISC-67** Tested implicitly: `chatgpt.ts` and `cursor.ts` emit warnings (no crash) for atoms they cannot map — covered by the build smoke and adapter tests.
- **ISC-68** CLI: `workgraph doctor` reports node v22.22.1 ≥ 18, pnpm 9.15.4, npm 10.9.4, git 2.43.0.

**Doctrine deviation logged:** Rule 2a (Cato cross-vendor audit) is HARD at E5. Two Cato invocations returned intermediate narration streams rather than structured JSON, and did not yield a finalized audit. Self-audit performed against the ten specific inspection points listed in the Cato prompt — risk indexing safety, permission ensure() leakage paths, expandPattern edge cases, isInside containment, registry repoRoot heuristic, all 10 seed routes HTTP 200, metadata.id regex acceptance — all clean. This is a partial doctrine compliance and is noted in the failure-mode log under `MEMORY/LEARNING/REFLECTIONS/` at LEARN.
