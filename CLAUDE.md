# agent-pack

AgentPack is an open-source (MIT) standard, registry, and CLI for packaging and installing agent configurations across platforms. TypeScript monorepo: `packages/{core,cli,db}` + `apps/registry` + `examples/pr-quality`. The repo is currently PRIVATE (planned to go public — see `STATUS.md` for the operator-only visibility flip).

## Project context (migrated from memory)

The open-source positioning is load-bearing: the entire architecture (self-host registry, no required SaaS account, enterprise gated on demand-signal not pricing) only matters if the code is visible. Git is the default distribution mechanism — `agentpack install github:owner/repo@ref` works without any hosted registry. The hosted registry is an optional convenience for cross-org discovery and the enterprise self-host path.

### System of record

- `ISA.md` — the canonical spec (system of record for implemented capabilities).
- `Plans/ROADMAP.md` — phased roadmap with tool-verifiable gates per phase.
- `STATUS.md` — current shipped-phase status.

### Phase gating

- Phase 6 (enterprise self-host) is GATED per `Plans/PHASE-6-GATE.md`. Do not implement it. Trigger condition: the first paying-customer conversation about enterprise self-host.

### Release / deploy notes

- v0.3.0 registry promotion is held until `scripts/smoke-e2e.sh` round-trips publish→install against live infra (needs `DATABASE_URL` + R2 + GitHub OAuth).
- Vercel: project `agent-pack-registry` is linked under the `keen-media` team. First deploy needs `rootDirectory = apps/registry` set in the dashboard, then `vercel --prod=false` from repo root.
