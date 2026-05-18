# Contributing to AgentPack

Thanks for your interest. This project is at v0.1 — APIs and the manifest schema may still shift before v1.0. Open an issue before large changes.

## Local setup

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test           # 67 tests across core + CLI
pnpm build
```

## Layout

- `packages/core` — the AgentPack engine (schema, parser, validator, permission/risk engines, planner, adapters, seed packs). All product logic lives here.
- `packages/cli` — the `workgraph` binary. Thin wrappers around the core API plus rendering.
- `apps/registry` — the Workgraph Registry Next.js app. Renders seed packs and embeds the validator.
- `examples/pr-quality` — example pack, also used by tests.
- `spec/` — original build packet; treated as design history.
- `docs/` — reference docs (standard, security, adapters, CLI).
- `ISA.md` — the living ideal-state articulation (test harness + done condition).

## Pull-request expectations

1. `pnpm verify` (typecheck + lint + test + build) must pass locally.
2. New behavior changes should add a test covering the new path.
3. Security-relevant changes (permission engine, risk engine, adapter file outputs, path handling) should add a test in `packages/core/tests/security.test.ts`.
4. If you add a manifest schema field, update:
   - `packages/core/src/schema/types.ts`
   - `packages/core/src/schema/agentpack.schema.ts`
   - `schemas/AGENTPACK.schema.json`
   - `docs/agentpack-standard.md`
   - one or more tests
5. If you add a target platform, register it in `packages/core/src/adapters/index.ts`, write a new adapter in `packages/core/src/adapters/<target>.ts`, add a `TargetPlatform` literal, and cover it in tests.

## Security disclosure

Found a security issue? Please open a private GitHub Security Advisory (Settings → Security → Advisories → "Report a vulnerability") rather than a public issue. Do not include exploit details in public channels until a fix lands.

## Style

- TypeScript strict mode is on; the lint config is intentionally light. Prefer clarity over cleverness.
- Comments only where a future reader can't infer the why. (Don't restate the code.)
- Adapter outputs must stay deterministic — sort, drop unstable timestamps, etc.
- Never write outside `--out` during `pack export`. Path containment is enforced; don't undermine it.

## Release process

1. Bump `version` in the affected package.json files.
2. Add a dated entry to `CHANGELOG.md`.
3. Tag the release.

(There's no published npm artifact yet — packs are consumed directly from the example folder for now.)
