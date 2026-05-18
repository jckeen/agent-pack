# Changelog

## Unreleased — 2026-05-18 (hardening pass)

Multi-agent security review (security-reviewer, Silas, code-reviewer, silent-failure-hunter, type-design-analyzer) closed four critical attack chains and seven high/medium findings against the v0.1 MVP. Folds into 0.1.1 when tagged.

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
