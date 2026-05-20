# Contributing to AgentPack

Thanks for your interest. This project is at **v0.5.0-dev** — the manifest schema (`agentpack: "1.0"`) and the wire-protocol surface in [`Plans/PROTOCOL.md`](./Plans/PROTOCOL.md) are stable; the registry deploy story and a few CLI flags are still moving. Open an issue before large changes.

## Local setup

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test           # full suite — see STATUS.md for the current passing count
pnpm build
pnpm verify         # the canonical pre-PR gate: typecheck + lint + test + build
```

`pnpm verify` is the gate every PR has to clear locally and in CI before merge.

## Layout

- `packages/core` — the AgentPack engine: schema, parser, validator, permission/risk engines, planner, adapters, install/uninstall/verify/rollback engines, git-source resolver, signing module, cache, policy enforcement, seed packs. All product logic lives here.
- `packages/cli` — the `agentpack` binary. Thin wrappers around the core API plus rendering. Run the local build via `node packages/cli/dist/index.js …` until the npm artifact ships.
- `packages/db` — `@agentpack/db`: Drizzle schema, queries, migrations for the registry's Postgres backend.
- `apps/registry` — `@agentpack/registry`: Next.js 15 App Router app. Renders seed packs in JSON-fallback mode without any env vars; switches to DB-backed mode when `DATABASE_URL` is set (see `apps/registry/.env.example`).
- `examples/pr-quality` — the canonical reference pack. Used by tests, docs, and the README quickstart.
- `spec/` — original build packet; treated as design history.
- `docs/` — reference docs (standard, security, adapters, CLI, registry, publish, install, remote-install, git-source, signatures, policy).
- `Plans/` — ROADMAP, PROTOCOL wire contract, PHASE-6-GATE.
- `ISA.md` — the living ideal-state articulation (test harness + done condition). Internal planning artifact, but kept in the repo for transparency.
- `scripts/` — `bring-up-prod.sh` (operator-only, provisions Neon + R2 + GitHub OAuth), `smoke-e2e.sh` (requires a deployed registry + `SMOKE_PUBLISH_TOKEN`), `seed-import.ts`.

## Pull-request expectations

1. **`pnpm verify` must pass locally and in CI** (typecheck + lint + test + build).
2. **New behavior changes** should add a vitest covering the new path.
3. **Security-relevant changes** (permission engine, risk engine, adapter file outputs, path handling, install engine, signing, git-source resolver, audit chain) should add a test in the affected package's `tests/` directory. The Phase-2 install engine has its own security-test surface; mirror that pattern.
4. **If you add a manifest schema field**, update:
   - `packages/core/src/schema/types.ts`
   - `packages/core/src/schema/agentpack.schema.ts`
   - `schemas/AGENTPACK.schema.json`
   - `docs/agentpack-standard.md`
   - one or more tests
5. **If you add a target platform**, register it in `packages/core/src/adapters/index.ts`, write a new adapter in `packages/core/src/adapters/<target>.ts`, add the `TargetPlatform` literal, write per-target adapter tests, and document it in `docs/adapters.md` + the README adapter table.
6. **If you add a CLI command**, register it in `packages/cli/src/index.ts`, write a `packages/cli/src/commands/<name>.ts`, add a vitest, and document it in `docs/cli.md` and the README CLI-reference highlights.
7. **CHANGELOG**: every PR that ships user-visible behavior updates `CHANGELOG.md` with a dated entry under the current `*-dev` section.

The PR template at `.github/PULL_REQUEST_TEMPLATE.md` includes a checklist that covers the above.

## Security disclosure

Found a security issue? Please open a private GitHub Security Advisory (Settings → Security → Advisories → "Report a vulnerability") rather than a public issue. Do not include exploit details in public channels until a fix lands. Same for any cosign / Sigstore / token / publish-pipeline finding.

## Style

- TypeScript strict mode is on; the lint config is intentionally light. Prefer clarity over cleverness.
- Comments only where a future reader can't infer the why. (Don't restate the code.)
- Adapter outputs must stay deterministic — sort, drop unstable timestamps, etc. The `pack export` determinism test runs in CI.
- Install / uninstall / verify must never write outside `projectRoot`. Path containment via `realpath` is enforced; don't undermine it.
- Logging in `apps/registry/` should not include secrets, raw tokens, or full request bodies of publish flows.

## Release process

Releases are tagged from `master`.

1. Bump `version` in the affected `package.json` files (`packages/core`, `packages/cli`, `packages/db`, `apps/registry`, root) to one canonical version per release.
2. Add a dated entry to `CHANGELOG.md` summarizing user-visible additions, fixes, and deferrals.
3. Update `STATUS.md` to reflect the new state.
4. Tag the release: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push --follow-tags`.
5. CI publishes the npm artifacts (planned starting v0.3.0 promotion — until then, install via clone + build per the README quickstart).

## Getting help

- Search [open issues](https://github.com/jckeen/agent-pack/issues) — your question may already be answered.
- Open a [bug report](./.github/ISSUE_TEMPLATE/bug_report.yml) or [feature request](./.github/ISSUE_TEMPLATE/feature_request.yml).
- Read the [roadmap](./Plans/ROADMAP.md) — phase status and intent is published.

We follow the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md).
