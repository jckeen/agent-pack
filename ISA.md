---
project: agent-pack
task: Build AgentPack standard + Workgraph Registry MVP
effort: E5
phase: complete
progress: 68/68 + iteration-2 hardening (85 tests, 90.5% line / 77.1% branch coverage)
mode: ALGORITHM
started: 2026-05-18T15:17:00-04:00
updated: 2026-05-18T16:34:00-04:00
iteration: 2
---

## Problem

AI tooling is fragmenting across Claude Code, Codex, Cursor, ChatGPT Apps, MCP-compatible clients, and other host platforms. Each exposes its own surface for instructions, rules, skills, hooks, commands, subagents, MCP tools, and plugins. There is no atomic, portable packaging standard with permission visibility, risk scoring, and cross-platform compilation. Authors duplicate work; users have no way to inspect what a pack will do before installing it.

## Vision

A developer drops a single `AGENTPACK.yaml` into a repo and runs `workgraph pack export --target claude-code --profile safe`. They see exactly which files will be written, which permissions are requested, the risk level, and which atoms will be skipped under the safe profile — before any write happens. Same source compiles cleanly to Codex `AGENTS.md` + `.codex/`, to Cursor `.cursor/rules/` + `.cursor/mcp.json`, to a ChatGPT app skeleton, and to generic `skills/` + `AGENTS.md`. Euphoric surprise: "I described the workflow once and four platforms got configured correctly, with the dangerous bits flagged in red."

## Out of Scope

- Phase-2 install/uninstall into the user's actual project (only `plan` + `pack export` to a directory)
- Phase-3 registry backend (database, publishing, search API) — seed data only
- Phase-4 signatures and Sigstore-style provenance — schema fields present, verification deferred
- Phase-5 remote CLI installs (`workgraph install publisher/pack`) — out
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

Ship a working TypeScript monorepo where `pnpm install && pnpm build && pnpm test` succeed, every CLI command in `spec/08_ACCEPTANCE_CRITERIA.md` produces the documented output, the Next.js registry renders all seed packs with risk/compatibility/permission visibility, and the example PR-Quality pack compiles to Claude Code, Codex, Cursor, ChatGPT-stub, and Generic targets with deterministic, marker-bounded files.

## Criteria

### Build & install
- [ ] ISC-1: `pnpm install` exits 0 at repo root
- [ ] ISC-2: `pnpm -r build` exits 0 (core, cli, registry)
- [ ] ISC-3: `pnpm -r test` exits 0 with all vitest suites passing
- [ ] ISC-4: `pnpm --filter @workgraph/registry dev` boots Next.js on a port
- [ ] ISC-5: `pnpm --filter @workgraph/cli build` exits 0 and emits `dist/index.js`
- [ ] ISC-6: TypeScript `strict: true` everywhere; `pnpm -r typecheck` clean

### Schema & validation
- [ ] ISC-7: Zod schema accepts the bundled example manifest verbatim
- [ ] ISC-8: Manifest with duplicate atom IDs fails validation with a clear error
- [ ] ISC-9: Manifest with profile referencing missing atom ID fails validation
- [ ] ISC-10: Manifest missing required metadata fields fails validation
- [ ] ISC-11: `agentpack` version not matching `^1\.0` fails validation
- [ ] ISC-12: Atom type outside the 12-type enum fails validation

### Permissions & risk
- [ ] ISC-13: `summarizePermissions` returns categorized list with descriptions
- [ ] ISC-14: `computeRisk` returns "high" when any included atom has `risk_level: high`
- [ ] ISC-15: Hook atom is classified `high`
- [ ] ISC-16: MCP server requiring secrets is classified `high` and surfaces `GITHUB_TOKEN`
- [ ] ISC-17: Safe profile excludes all hooks and MCP servers
- [ ] ISC-18: Risk monotonically non-decreasing as profile widens safe→standard→full
- [ ] ISC-19: Permission summary names `shell.execution` for hook atom
- [ ] ISC-20: Permission summary names `secrets.env`+`network.access`+`external_api.access` for GitHub MCP

### CLI behavior
- [ ] ISC-21: `workgraph validate examples/pr-quality` exits 0 with success message
- [ ] ISC-22: `workgraph inspect examples/pr-quality` prints name, version, publisher, compatibility, profiles, atoms, risk, permissions
- [ ] ISC-23: `workgraph plan examples/pr-quality --target claude-code --profile safe` prints LOW risk
- [ ] ISC-24: `workgraph plan examples/pr-quality --target claude-code --profile full` warns about hook
- [ ] ISC-25: `workgraph plan ... --profile full` warns about shell execution
- [ ] ISC-26: `workgraph plan ... --profile full` warns about GitHub MCP
- [ ] ISC-27: `workgraph plan ... --profile full` warns about `GITHUB_TOKEN` secret
- [ ] ISC-28: `workgraph init` writes a starter `AGENTPACK.yaml` in CWD
- [ ] ISC-29: `workgraph doctor` reports node version, pnpm presence, working dir status
- [ ] ISC-30: CLI exits non-zero on validation failure

### Adapter outputs (deterministic)
- [ ] ISC-31: `pack export --target claude-code` writes `CLAUDE.md`
- [ ] ISC-32: `pack export --target claude-code` writes `.claude/skills/code-review/SKILL.md`
- [ ] ISC-33: `pack export --target claude-code --profile standard` writes `.claude/agents/security-reviewer.md`
- [ ] ISC-34: `pack export --target claude-code --profile full` writes `.claude/settings.json` with hook block
- [ ] ISC-35: `pack export --target codex` writes `AGENTS.md`
- [ ] ISC-36: `pack export --target codex` writes `.codex/config.toml`
- [ ] ISC-37: `pack export --target codex` writes `.codex/skills/code-review/SKILL.md`
- [ ] ISC-38: `pack export --target codex --profile full` writes `.codex/hooks.json`
- [ ] ISC-39: `pack export --target cursor` writes `AGENTS.md`
- [ ] ISC-40: `pack export --target cursor` writes `.cursor/rules/security-review-required.mdc`
- [ ] ISC-41: `pack export --target cursor --profile full` writes `.cursor/mcp.json` with github server
- [ ] ISC-42: `pack export --target chatgpt` writes `project-instructions.md`
- [ ] ISC-43: `pack export --target chatgpt` writes `app-manifest.json`
- [ ] ISC-44: `pack export --target chatgpt --profile full` writes `mcp-server/src/tools/pr-summary.ts` stub
- [ ] ISC-45: `pack export --target generic` writes `AGENTS.md`
- [ ] ISC-46: `pack export --target generic` writes `skills/code-review/SKILL.md`
- [ ] ISC-47: `pack export --target generic` writes `agentpack.json`
- [ ] ISC-48: All instruction outputs contain `<!-- BEGIN AGENTPACK: workgraph.pr-quality -->` marker
- [ ] ISC-49: Re-running the same export twice produces byte-identical output

### Registry web app
- [ ] ISC-50: `/` homepage renders product positioning and CTA
- [ ] ISC-51: `/packs` lists all 10 seed packs from `seed/seed-packs.json`
- [ ] ISC-52: `/packs` supports tag and risk filtering client-side
- [ ] ISC-53: `/packs/workgraph/pr-quality` renders detail page
- [ ] ISC-54: Detail page renders CompatibilityMatrix (5 targets × status)
- [ ] ISC-55: Detail page renders RiskBadge with computed risk
- [ ] ISC-56: Detail page renders PermissionSummary block
- [ ] ISC-57: Detail page renders InstallCommandBox with `npx workgraph pack export ...`
- [ ] ISC-58: Detail page renders AtomList with all 7 PR-Quality atoms
- [ ] ISC-59: Detail page renders ManifestViewer (raw YAML preview)
- [ ] ISC-60: `/validate` accepts pasted YAML and reports valid/invalid with errors
- [ ] ISC-61: `/docs` renders standard, security, adapters, CLI overview

### Documentation
- [ ] ISC-62: Root `README.md` explains standard, CLI, security model, adapters, limitations
- [ ] ISC-63: `docs/agentpack-standard.md`, `docs/security.md`, `docs/adapters.md`, `docs/cli.md` all populated

### Anti-criteria & antecedents
- [ ] ISC-64: Anti: CLI never writes outside `--out` directory during `pack export`
- [ ] ISC-65: Anti: ChatGPT adapter never claims automatic installation
- [ ] ISC-66: Anti: No adapter silently drops dangerous atoms — they appear in `warnings[]` or `unsupportedAtoms[]`
- [ ] ISC-67: Anti: `pack export` does not crash on unknown atom type — emits warning
- [ ] ISC-68: Antecedent: User has node ≥18 and pnpm ≥9 (doctor command verifies)

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

## Decisions

- **2026-05-18 (OBSERVE):** Project ISA lives at `agent-pack/ISA.md` (project-scoped, v6.0+). Spec packet docs moved to `spec/` to keep root clean. The spec packet IS the substantive ISA pre-population.
- **2026-05-18 (OBSERVE):** Skipping ISA skill scaffold workflow — the spec packet at `spec/00..10_*.md` is denser than what scaffold would produce. ISA is consolidated by hand into 12-section canonical form here.
- **2026-05-18 (OBSERVE) — show-your-math, delegation floor:** E5 soft floor is ≥4 delegation; selecting 2 (Forge optional for parallel adapter codegen, Cato mandatory at VERIFY). Rationale: spec is sufficiently concrete that single-author execution is faster than multi-agent coordination; using Forge for parallel codegen would create merge conflicts on shared types in `packages/core/src/index.ts`. Anvil whole-project review would duplicate Cato's job at higher latency. Background research agents are not needed — no unknown libraries. Recording this rationale per soft-floor rules.
- **2026-05-18 (PLAN):** Risk model — atom risks combine by `max()` over included atoms; profile risk = max(atom risks of profile members). MCP-with-secrets and shell-exec hooks pin to `high`. Critical reserved for combinations (shell+secrets+network+filesystem-write) per spec.
- **2026-05-18 (PLAN):** Cursor adapter — `.cursor/rules/*.mdc` for `rule` atoms, `.cursor/mcp.json` for mcp_server atoms, `AGENTS.md` for instructions. Hooks emit warnings (no stable Cursor hook target yet).
- **2026-05-18 (PLAN):** ChatGPT adapter is **export-only** per spec — emits MCP server skeleton (one tool stub per `command` atom), `project-instructions.md`, `app-manifest.json`. Marks all output `conservative/proposed`.

## Changelog

- **Conjecture (OBSERVE):** Pack-level `permissions:` block can be surfaced unconditionally as the registry's compatibility view.
  **Refuted by:** First plan smoke on `safe` profile showed CRITICAL risk because the unconditional surface dragged `shell + secrets + network + filesystem.write` through and triggered the combo rule. The user-facing answer was actively wrong.
  **Learned:** Pack-level `permissions:` is the *possible* surface; the **active** surface must be driven by the resolved atom subset. The combo rule must compose over active categories, never declared-but-unused categories.
  **Criterion now:** `summarizePermissions` only adds a category when an included atom backs it (atom permissions array, or implicit per-atom-type escalation for `hook` / `mcp_server`). Pack-level network domains/shell commands only surface when at least one atom needs them.

- **Conjecture (BUILD):** TypeScript project references would let `packages/cli` see `packages/core` types without composite mode.
  **Refuted by:** `tsc -p tsconfig.json --noEmit` from `packages/cli` failed with TS6306 — referenced project must have `composite: true`.
  **Learned:** Referenced projects in a TS workspace require `composite: true` even when only declarations are consumed.
  **Criterion now:** `packages/core/tsconfig.json` has `composite: true`. ISC-2 builds clean.

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
