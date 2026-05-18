# Changelog

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
