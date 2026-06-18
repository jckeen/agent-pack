# AgentPack Roadmap — Phases 3-7

**Status:** As of `0.7.0-dev`, Phases 1–5 are shipped in code (see [`STATUS.md`](../STATUS.md) for the authoritative shipped state); Phase 6 is 🔒 gated and Phase 7 is planned. This document is the original phase-by-phase plan and decision log for Phases 3–7 — the path to a full hosted-registry + signed + remote-installable + enterprise-ready AgentPack ecosystem. Some Phase 3–5 sections below describe work that has since landed; treat STATUS.md as the source of truth for what is actually shipped.

This is an opinionated roadmap. Every open question gets a concrete answer with rationale and an explicit "revisit if X" trigger. Where it says **Decision:**, that is the pinned choice; argue with it now, not during Phase 5 implementation.

---

## Where we are

Phase 1 (v0.1.x) shipped the AgentPack standard: `AGENTPACK.yaml` manifest, zod schema, 5 platform adapters (Claude Code, Codex, Cursor, ChatGPT export-only, Generic), planner + permission + risk engines, CLI (`init`, `validate`, `inspect`, `plan`, `pack export`, `doctor`), and the AgentPack Registry web app rendering 10 seed packs.

Phase 2 (v0.2.0) shipped local install/uninstall: WAL-protected `agentpack install` (begin → backup → atomic writes → commit), deterministic `AGENTPACK.lock` with per-atom and per-file SHA-256, hash-chained `.agentpack/history.jsonl`, `agentpack verify` for drift detection, `agentpack rollback` with supersession refusal, `agentpack diff` for unified-diff previews. 152 tests, 88.68% line coverage, two pre-ship CRITICAL security findings closed (TOCTOU symlink-swap, Windows-drive bypass).

The lockfile reserves slots for `signatures` (Phase 4) and `dependencies` (Phase 3 transitive resolution). The per-file SHA-256 list is what Phase 4 cosign will sign over. No `lockfileVersion: 2` bump is anticipated through Phase 7.

---

## Phase dependency graph

```
                                    ┌─────────────────────┐
                                    │ Phase 1 (compile)   │
                                    │ Phase 2 (install)   │  ← shipped
                                    └──────────┬──────────┘
                                               │
                          per-file SHA-256, lockfile.signatures slot
                                               │
                                ┌──────────────┴──────────────┐
                                ▼                              ▼
                    ┌─────────────────────┐         ┌─────────────────────┐
                    │ Phase 3             │         │ Phase 4             │
                    │ Registry backend    │         │ Signatures + trust  │
                    │ (v0.3.0)            │         │ (v0.4.0)            │
                    └──────────┬──────────┘         └──────────┬──────────┘
                       PackVersion table                Phase 3 PackVersion
                       publish flow                     .signature column
                       remote-fetchable bytes           cosign verify
                                │                              │
                                └──────────┬───────────────────┘
                                           ▼
                                ┌─────────────────────┐
                                │ Phase 5             │
                                │ Remote CLI installs │
                                │ (v0.5.0)            │
                                └──────────┬──────────┘
                                CLI auth, offline cache,
                                agentpack.policy.json
                                           │
                                           ▼
                                ┌─────────────────────┐
                                │ Phase 6             │
                                │ Enterprise          │
                                │ (v0.6.0)            │
                                └──────────┬──────────┘
                                Orgs, SSO, audit log,
                                policy-as-code
                                           │
                                           ▼
                                ┌─────────────────────┐
                                │ Phase 7             │
                                │ AgentPack integration│
                                │ (v0.7.0 / v1.0.0)   │
                                └─────────────────────┘
                                Export workflows,
                                trust graph,
                                Agent Commons
```

**Hard dependencies** (Phase X _cannot_ start without artifact from Phase Y): 3 → 5 (registry exists to install from), 3 → 4 (PackVersion row holds signature column + metadata), 4 → 5-soft (verified-by-default is the right UX but Phase 5 can ship unsigned install), 5 → 6 (enterprise reuses CLI auth + policy primitives), 6 → 7-soft (AgentPack integration can land standalone but enterprise customers are the natural early Workgraph customers).

**Why this order:** Phase 3 unlocks the registry economy. Phase 4 unlocks supply-chain trust (and Phase 5 ships with verification on by default). Phase 5 unlocks the "one command, anywhere" remote-install ergonomics. Phase 6 unlocks org adoption and policy. Phase 7 unlocks the network effect by making the registry a destination for non-hand-authored workflows.

---

## Phase 3 — Registry backend (v0.3.0)

**Intent.** Make every published AgentPack referenceable by a stable identity (`publisher/pack@version`) that resolves to bytes anyone can fetch. Phase 2 ships the install machinery; Phase 3 ships the publish machinery and the catalog backing it.

**Effort tier estimate:** E5 — the largest surface area in the roadmap (infrastructure + auth + publish flow + search + registry API + the existing web app extended). Tier is complexity, not calendar time; the ship gate is standing up live infra, not coding effort (see the effort table).

### Decisions

#### D3.1 Datastore — Postgres on Neon

**Decision:** Postgres 16, hosted on Neon, accessed via the Vercel-Neon integration. Use Drizzle ORM (not Prisma) for the schema layer.

**Rationale:** The 13 data models from `spec/06_DATA_MODELS_AND_API.md` are FK-heavy with real hierarchies (`Publisher → Pack → PackVersion → Atom`). Postgres FTS covers Phase 3 search needs. Neon's serverless branching aligns with Vercel preview-deploy workflows out of the box. Drizzle over Prisma because Drizzle's generated SQL is debuggable, migrations are sql-first, and the Vercel-edge story is cleaner.

**Tightening (from schema-reviewer):** Neon free-tier cold-start bites publish latency. Configure `pool_mode=transaction` via the bundled PgBouncer, and keep one always-warm Neon branch pinned to prod. Preview branches can cold-start.

**Revisit if:** Operational cost of Neon at ~10K packs exceeds $200/mo, or transactional pooling pinches the publish flow. Plan B: Supabase Postgres (same shape, different bill). Plan C: AWS RDS if Phase 6 self-host customers demand it.

#### D3.2 Auth — NextAuth (Auth.js v5) with GitHub OAuth, plus hashed CLI tokens

**Decision:** NextAuth v5 (Auth.js) in `apps/registry` with GitHub OAuth as the only login provider for v0.3. CLI publish uses opaque tokens minted on the website, prefixed `agp_live_<random>` so GitHub secret-scanning catches leaks. The DB stores `sha256(token)`, `token_prefix` (first 8 chars for UI display), and a `scopes` jsonb column from day one.

**Rationale:** GitHub OAuth matches the developer audience and inherits their identity. Opaque CLI tokens are the standard pattern (npm, PyPI, crates.io variants). NextAuth is the App Router-native option; Clerk would lock us out of Phase 6 self-host. Adding `scopes` later is migration hell — pay the schema cost now.

**Schema slot:**

```sql
create table api_tokens (
  id              uuid primary key,
  user_id         uuid references users(id) not null,
  publisher_id    uuid references publishers(id),  -- null = user-scoped, set = publisher-scoped
  name            text not null,
  token_prefix    text not null,                   -- first 8 chars of `agp_live_…`, for UI
  token_sha256    text not null unique,            -- sha256(full token)
  scopes          jsonb not null default '[]',     -- ["publish:packs", "read:private"]
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz
);
```

**Revisit if:** A non-GitHub identity provider becomes important (Google Workspace, Microsoft) — defer to Phase 6 multi-IdP. Or if MFA-on-publish becomes a security requirement before then.

#### D3.3 Hosting — single Vercel deploy

**Decision:** Extend the existing `apps/registry` Next.js App Router app with API routes for publish/search/download. No split-service architecture. Deploy to the same Vercel project that already hosts the registry web UI.

**Rationale:** Minimum new infra. Next.js App Router serves both static pack pages and API routes from one codebase. Edge Functions for read-heavy routes (`GET /api/packs/...`), Node runtime for publish (multi-MB body, stream-to-storage). The existing `apps/registry` is already shaped for this.

**Revisit if:** Cold-start tail latency hurts publish UX, or background jobs (security scans in Phase 4) outgrow Vercel functions. Plan B: split a `apps/registry-worker` Render/Fly service.

#### D3.4 Artifact storage — Cloudflare R2 (NOT Vercel Blob)

**Decision:** Cloudflare R2 for the raw `AGENTPACK.yaml`, `README.md`, and atom body files. Access via S3-compatible SDK from the Next.js API routes. Buckets: `agentpack-artifacts-prod` (immutable per-version paths) and `agentpack-artifacts-staging`.

**Rationale (flipped from initial pick of Vercel Blob):** R2 has zero egress pricing — which matters because every `agentpack install publisher/pack` in Phase 5 reads from this bucket. Vercel Blob's egress gets ugly past ~100GB. R2 is S3-compatible, so Phase 6 self-host customers can point at their own S3-compatible store with one env var change. SDK ergonomics are a wash.

**Path layout:**

```
/<publisher>/<pack>/<version>/manifest.yaml
/<publisher>/<pack>/<version>/readme.md
/<publisher>/<pack>/<version>/atoms/<atom-id>/<file-path>
/<publisher>/<pack>/<version>/manifest.json    (parsed + canonicalized)
```

**Revisit if:** R2 region availability becomes a blocker for an enterprise customer who needs in-region storage. Plan B: Tigris (multi-region S3-compatible) or pointing at a customer's own S3.

#### D3.5 Search — Postgres FTS

**Decision:** Postgres FTS via a `tsvector` generated column on `packs` (concatenating `name`, `description`, `tags`, current `latestVersion.readme` excerpt), with a GIN index. No external search service in Phase 3.

**Rationale:** At <1000 packs, Postgres FTS handles it with p95 <100ms. Generated column (not trigger) — fewer footguns, the index stays in sync mechanically. Skip `pg_trgm` (typo tolerance) until users actually complain — premature.

**Schema slot:**

```sql
alter table packs add column search tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(description,'')), 'B') ||
    setweight(to_tsvector('english', array_to_string(coalesce(tags,'{}'),' ')), 'C')
  ) stored;
create index packs_search_idx on packs using gin(search);
```

**Revisit if:** p95 search exceeds 200ms, or typo tolerance / cross-field relevance scoring becomes the bottleneck. Plan B: Meilisearch (self-host) or Typesense Cloud.

#### D3.6 Publish UX — two-phase, presigned-URL, finalize

**Decision:** `agentpack publish [path]` flow:

```
1. Client: read manifest, compute lockfile-style per-file SHA-256.
2. Client → POST /api/publish/init { publisher, pack, version, files: [{path, sha256, bytes}], metadata }
3. Server: validate metadata + token scopes, reject duplicate version (409), return:
   { publish_id, presignedUploads: [{path, url, headers}] }
4. Client: upload each file to its presigned R2 URL.
5. Client → POST /api/publish/:publish_id/finalize
6. Server: verify each uploaded blob's sha256 matches the declared one;
   on success, insert PackVersion + Atom + Compatibility rows in one tx;
   on failure, mark publish_id as 'aborted'.
7. Server: nightly cron GC's `aborted` and `pending > 24h` publish_ids + their orphan blobs.
```

**Rationale (changed from initial design):** Two-phase prevents orphan blobs if the metadata POST fails after artifacts upload. This is the pattern npm, crates.io, and PyPI all use (variants). Immutable versions — republishing the same `metadata.version` returns 409 always (no force-republish in v0.3; tombstone-and-revoke is a Phase 4 concern).

**Auth:** Token via `AGENTPACK_TOKEN` env var or `~/.agentpack/credentials.json` (precedence: env wins). Token must have `publish:packs` scope and be scoped to the target publisher.

**Revisit if:** Multi-GB packs become common — chunked uploads and resumable presigned URLs are the upgrade path.

#### D3.7 Reviews — schema lands, GET works, POST returns 501

**Decision:** Phase 3 lands the `Review` table + `GET /api/packs/.../reviews` endpoint serving seed reviews (manually-curated). `POST /api/packs/.../reviews` returns 501 with `{ error: "user_reviews_not_yet_available" }`. Same response shape from GET that POST will eventually return — clients don't need to change when POST goes live.

**Rationale:** UGC moderation is a real engineering problem (spam, rating manipulation, abuse reports). It does not belong on the critical path for v0.3 "users can publish and install." Lock the schema now to avoid migration churn; defer the moderation infrastructure to Phase 3.5 (revisit in Phase 5's vicinity, NOT Phase 6 — Phase 6 should not have to absorb UGC).

**Revisit if:** Demand for reviews comes from publishers (social proof for adoption) before Phase 5 ships. Don't slip it into Phase 6.

#### D3.8 Seed-data migration — one-shot import, idempotent

**Decision:** `scripts/seed-import.ts` (new in v0.3.0): reads the existing `seed/seed-packs.json`, checks `(publisher_slug, pack_slug, version)` against the DB, INSERTs rows that don't exist, SKIPs and logs ones that do. Run it as `pnpm seed:import` — NOT auto-on-deploy. After Phase 3 ships, `seed/seed-packs.json` stays in the repo as historical documentation, removed from the runtime path.

**Rationale:** Auto-seed-on-deploy bites in staging when state diverges. Idempotent guard means safe to re-run after partial failure. Removing from runtime forces the registry web app to read from DB only (eliminates the JSON-vs-DB drift class of bug).

**Revisit if:** Demand for "publishing without auth" (e.g. project-level seed packs maintained in git) — that's actually a different mechanism (Phase 3.5 or `--from-git` flag), not a seed-import concern.

### Phase 3 deliverables

- `packages/db` — new workspace package with Drizzle schema, migrations, query helpers.
- `apps/registry` — new API routes under `app/api/{packs,publish,search,reviews,downloads,adapters,validate,plan,export}/`.
- `apps/registry` — auth via NextAuth v5, GitHub OAuth provider, session pages.
- `packages/cli` — new `publish` subcommand with two-phase flow.
- `packages/cli` — new `login` / `whoami` / `tokens` subcommands.
- `scripts/seed-import.ts` — idempotent seed migration.
- `apps/registry/components/PackDetail.tsx` updates — fetch from DB, not JSON.
- Phase 3 docs at `docs/registry.md` and `docs/publish.md`.

### Phase 3 dependencies

- **Hard:** Phase 2 lockfile schema (we publish lockfile-compatible checksums alongside the YAML). No code change to Phase 2 — additive only.
- **None on Phase 4, 5, 6, 7** — Phase 3 ships standalone.

### Phase 3 gate (tool-verifiable "phase done")

1. `gh repo clone jckeen/agent-pack && pnpm install && pnpm dev` boots the registry against a Neon prod branch.
2. `agentpack login` opens browser, completes GitHub OAuth, writes `~/.agentpack/credentials.json`.
3. `agentpack publish examples/pr-quality` against staging registry returns success, new row appears in `pack_versions` table.
4. `curl https://registry.agentpack.dev/api/packs/agentpack/pr-quality/versions/0.1.0/manifest.yaml` returns the published bytes.
5. `https://registry.agentpack.dev/packs/agentpack/pr-quality` renders detail page (now sourced from DB).
6. Searching "pr quality" in the registry UI returns the pack.
7. Attempting to republish `0.1.0` returns 409.
8. `pnpm seed:import` is idempotent — second run logs "0 inserted, 10 skipped."

---

## Phase 4 — Security and trust (v0.4.0)

**Intent.** Make `publisher/pack@version` → bytes verifiable without trusting the registry. A user with a published pack's signature + public-key trust anchor can prove the bytes haven't been tampered with, even if the registry is compromised.

**Effort tier estimate:** E4 (focused single-domain work — signatures + verification CLI + UI badges).

### Decisions

#### D4.1 Signing scheme — Sigstore cosign keyless

**Decision:** Sigstore cosign with keyless signing (OIDC identity from GitHub via Fulcio short-lived cert + Rekor transparency log). Publishers do not manage long-lived signing keys; the signature commits to the publisher's GitHub identity at signing time.

**Rationale:** Long-lived publisher keys are an operational nightmare (rotation, revocation, loss). Sigstore keyless is the npm-provenance / PyPI Trusted Publishing direction; matching it inherits the trust mental model developers already have. Fulcio + Rekor are run by the OpenSSF — sufficient infrastructure for v0.4. The lockfile already reserves `signatures.manifest` and `signatures.provenance` slots.

**Revisit if:** A customer needs offline signing (no Fulcio network round-trip) for an air-gapped publish flow. Plan B: cosign with a publisher-managed key in `~/.agentpack/signing-key`, but that's Phase 6 enterprise.

#### D4.2 Key custody — none (keyless, see D4.1)

**Decision:** No publisher key custody in v0.4. The Fulcio short-lived cert is the binding between OIDC identity and signature; Rekor is the tamper-evident log.

**Rationale:** Follows from D4.1. The thing the user trusts is "GitHub user X signed pack Y at time T" — not "publisher's long-lived key signed Y."

**Revisit if:** D4.1 revisits. Same trigger.

#### D4.3 CLI verify UX — `agentpack verify --sig`

**Decision:** Extend the existing Phase 2 `agentpack verify <packId>` with a `--sig` flag. When set:

```
1. Read AGENTPACK.lock from project root.
2. For each atom output file: confirm on-disk SHA-256 matches lockfile (Phase 2 logic).
3. Read lockfile.signatures.manifest — base64-decoded cosign signature.
4. Read lockfile.signatures.cert — base64-decoded Fulcio short-lived cert.
5. Verify cosign signature against the canonical lockfile bytes (with signatures.* fields removed).
6. Verify cert is in Rekor; verify OIDC identity claim matches the publisher recorded in AGENTPACK.yaml.
7. Exit 0 on success, 4 on signature failure (separate exit code from existing 2 = drift, 3 = chain broken).
```

Without `--sig`, behavior is unchanged (Phase 2 drift check only).

**Rationale:** Backward-compatible (lockfile from Phase 2 has empty `signatures: {}` — verify --sig on those reports `unsigned: true, exit 5` rather than failing). Distinct exit codes make scripting trivial. Reuses Phase 2 drift-check primitive.

**Revisit if:** Verify becomes slow enough at scale that users disable it — then add a `--sig=offline` mode that skips Rekor lookup (trust on first use).

#### D4.4 Quarantine / block UX — registry-side mutable status field

**Decision:** Add `pack_versions.status` enum: `published` (default), `deprecated`, `yanked`, `quarantined`, `blocked`. CLI `agentpack install` and `agentpack verify --sig` honor:

- `published` — install proceeds as normal.
- `deprecated` — install proceeds with warning.
- `yanked` — install proceeds with warning ("yanked by publisher: <reason>"); existing installed versions keep working.
- `quarantined` — install REFUSED with override flag `--allow-quarantined`; UI surfaces in red.
- `blocked` — install REFUSED, no override (registry-administrative action).

Publishers can yank/un-yank their own versions; quarantine/block are registry-admin-only (Phase 6 enterprise admins for self-host).

**Rationale:** Yank-not-delete matches npm's mental model (immutable versions, mutable status). Quarantine-with-override gives the user the choice while making the unsafe action loud. Block is for legal/abuse-of-service, never overridable.

**Revisit if:** Publishers ask for `unpublish` (npm-style 72-hour grace window). Defer to Phase 6 — needs audit trail + admin approval.

### Phase 4 deliverables

- `packages/cli` — `agentpack verify --sig` implementation; cosign npm dep (`@sigstore/sign`, `@sigstore/verify`).
- `packages/cli` — `agentpack publish` signs the manifest after upload-finalize via Fulcio keyless flow.
- `packages/core` — `lockfile.signatures.{manifest,cert}` fields populated in `applyInstall` when CLI was run via remote install (Phase 5) and the registry returns a signature.
- `apps/registry` — `pack_versions.status` enum + migration.
- `apps/registry` — admin routes for quarantine/block (gated by `users.role`).
- `apps/registry` — UI badge for `signed` / `unsigned` / `quarantined` on pack detail.
- Phase 4 docs at `docs/signatures.md`.

### Phase 4 dependencies

- **Hard on Phase 3:** PackVersion row exists, registry-side admin routes exist, `pack_versions.status` column can be added.
- **Hard on Phase 2:** lockfile `signatures` reserved slot, per-file SHA-256 list as the integrity primitive.
- **Phase 5 soft dep:** Phase 5 ships with `verify --sig` on-by-default for remote installs; if Phase 5 ships before Phase 4 those installs are unsigned (acceptable but worse default).

### Phase 4 gate

1. `agentpack publish` to staging registry produces a signature; `pack_versions.status='published'`, `cosign_signature` is non-null.
2. The published pack's `AGENTPACK.lock` (downloaded via Phase 5 install or `curl`) has populated `signatures.manifest` and `signatures.cert` bytes.
3. `agentpack verify <packId> --sig` exits 0 against the freshly-signed pack.
4. Tampering with a single atom file → exit 2 (drift); tampering with the signature in the lockfile → exit 4 (signature mismatch).
5. Admin endpoint quarantines a version; the next `agentpack install` of that version REFUSES with exit 2 (or 0 + warning under `--allow-quarantined`).

---

## Phase 5 — Remote CLI installs (v0.5.0)

**Intent.** Make the CLI fetch (instead of filesystem-load) when given an identity: `agentpack install agentpack/pr-quality@0.1.0` works the same as `agentpack install examples/pr-quality` does today.

**Effort tier estimate:** E3 (smaller than 3 or 4 — most primitives are already shipped; this phase is plumbing them together).

### Decisions

#### D5.1 Resolver semantics — `agentpack install <publisher>/<pack>[@<version>]`

**Decision:** Identity grammar: `<publisher>/<pack>[@<version>]`. `<version>` defaults to "latest stable" (highest semver not pre-release, not yanked). `--registry <url>` overrides the default registry (default: `https://registry.agentpack.dev`). The resolver:

```
1. GET <registry>/api/packs/<publisher>/<pack>/versions/<resolved-version>/manifest.yaml
2. GET <registry>/api/packs/<publisher>/<pack>/versions/<resolved-version>/manifest.json  (parsed + canonicalized)
3. For each atom file referenced: GET <registry>/api/packs/.../atoms/<atom>/<file-path>
4. Compute lockfile from fetched bytes (same code path as local).
5. Verify each fetched file's SHA-256 against the manifest's declared hashes.
6. Hand off to Phase 2 applyInstall.
```

**Rationale:** Single resolver path means local-path install and remote-identity install share the planInstall → applyInstall code. The Phase 2 lockfile contract holds: same bytes → same lockfile, regardless of fetch source.

**Revisit if:** Cross-pack `dependencies` resolution becomes a concern (Phase 3 lockfile slot exists but is empty through Phase 5). Plan B: SAT solver à la pnpm; Phase 7 problem.

#### D5.2 Offline cache — content-addressed under `~/.agentpack/cache/`

**Decision:** Cache layout:

```
~/.agentpack/
├── cache/
│   ├── packs/
│   │   └── <publisher>/<pack>/<version>/      # decoded artifacts
│   ├── manifests/
│   │   └── <publisher>/<pack>/<version>.yaml  # raw manifest
│   └── blobs/
│       └── <sha256[0..2]>/<sha256>            # content-addressed blob store
├── credentials.json
└── policy.json                                # optional, Phase 5/6
```

Fetch flow: `cache.blobs/<sha>` lookup first; on miss, fetch + write + return. `cache.packs/<pub>/<pack>/<ver>/` is a view (symlinks into `blobs/`) for human inspection. `agentpack cache prune --max-age 30d` and `agentpack cache size` for housekeeping.

**Rationale:** Content-addressed dedup means installing the same atom across 10 packs costs disk once. Symlink view is human-readable; the blob store is the source of truth. Mirrors npm's `~/.npm/_cacache/` shape.

**Revisit if:** Cross-platform symlink semantics (Windows) cause friction. Plan B: hard-copy view instead of symlink view.

#### D5.3 CLI auth for private packs — token reuse from Phase 3

**Decision:** `agentpack install` sends `Authorization: Bearer <agp_live_…>` from `~/.agentpack/credentials.json` (Phase 3 `agentpack login` output) on every fetch. For pubic packs the header is ignored; for private packs (`visibility: private` in DB) the registry returns 403 without it. Token scope `read:packs` required; scope `read:private` required for private packs.

**Rationale:** Reuses Phase 3 token primitive — no new auth surface. `read:private` scope can be granted publisher-scoped (`read:private@<publisher>`) so an enterprise customer's token can only fetch their own private packs.

**Revisit if:** Multi-registry auth (one token per registry) becomes a concern — `~/.agentpack/credentials.json` becomes a map keyed by registry URL.

#### D5.4 `agentpack.policy.json` — opt-in install policy

**Decision:** Optional `agentpack.policy.json` at the project root (NOT under `.agentpack/`, because it's a user-authored guardrail, like `package.json` engines). Schema:

```json
{
  "policyVersion": 1,
  "registries": {
    "allowed": ["https://registry.agentpack.dev", "https://internal.example.com"],
    "default": "https://registry.agentpack.dev"
  },
  "packs": {
    "allowedPublishers": ["agentpack", "example-corp"],
    "blockedPacks": ["evil-corp/sketchy-pack"]
  },
  "install": {
    "requireSignature": true,
    "allowedProfiles": ["safe", "standard"],
    "deniedAtomTypes": []
  },
  "verify": {
    "onInstall": "required",
    "chain": "warn"
  }
}
```

CLI loads it on every install/verify invocation. Violations are hard refusals with exit 6 (separate from drift/chain-broken/signature-failure exit codes). Phase 6 layers org-policy on top.

**Rationale:** User-authored guardrail before Phase 6's centrally-managed policy. Lets a single dev or small team start enforcing "only signed packs from these publishers" without standing up infrastructure. Schema versioned so Phase 6 can extend.

**Revisit if:** Schema accretes too many fields → split into multiple files. Probably not before Phase 6.

### Phase 5 deliverables

- `packages/cli` — `agentpack install <publisher>/<pack>[@version]` resolver.
- `packages/cli` — `agentpack cache prune | size | clear`.
- `packages/core` — content-addressed blob store helpers.
- `packages/core` — `agentpack.policy.json` zod schema + loader + enforcer.
- `apps/registry` — `GET /api/packs/.../manifest.yaml` returns raw bytes; `/api/packs/.../atoms/<atom>/<file>` returns atom bytes.
- Phase 5 docs at `docs/remote-install.md` and `docs/policy.md`.

### Phase 5 dependencies

- **Hard on Phase 3:** registry exists at `https://registry.agentpack.dev`; `GET /api/packs/...` returns bytes.
- **Soft on Phase 4:** verified-by-default install is the right UX (policy `verify.onInstall: required`). If Phase 5 ships before Phase 4, policy defaults to `verify.onInstall: warn` instead of `required`.
- **None on Phase 6, 7.**

### Phase 5 gate

1. `agentpack install agentpack/pr-quality` (against staging registry) writes the files and lockfile identically to the local-path install.
2. Re-running it uses cache (no network on second fetch — log says `cache hit`).
3. `agentpack cache prune --max-age 7d` removes older blobs.
4. With `agentpack.policy.json` requiring signature, installing an unsigned pack exits 6.
5. With `agentpack.policy.json` restricting registries, fetching from an unlisted registry exits 6.
6. Private-pack install with no token exits 1; with valid `read:private` token, succeeds.

---

## Phase 6 — Enterprise (v0.6.0) — 🔒 **GATED**

> **Implementation deferred until the first paying-customer conversation about enterprise self-host.** Trigger conditions, design-space, and gate-flip procedure are in `Plans/PHASE-6-GATE.md`. Schema slots (`org_id` nullable on `users`+`packs`, `audit_events` table) stay reserved so the unlock is a migration, not a re-architecture. Do not implement Phase 6 code until the gate flips.

**Intent.** Make the registry + CLI + auth respect org boundaries, central policy, and audit-trail expectations. The enterprise unlock — orgs pay for what individuals don't.

**Effort tier estimate:** E5. Touches every surface (auth, DB schema, CLI, registry UI, billing-adjacent), and has the biggest "we got it wrong" cost because enterprise contracts have long memories.

### Decisions

#### D6.1 Org/workspace model — single-tenant SaaS first; OSS self-host as Phase 6.5

**Decision:** v0.6.0 ships multi-tenant SaaS only — `Org` becomes a first-class entity alongside `Publisher`, but the registry hosts all orgs in one Vercel+Neon deploy. OSS self-host (a customer running the registry on their own infra against their own Postgres + R2) is Phase 6.5, gated by the first concrete customer requirement.

Schema:

```sql
create table orgs (
  id              uuid primary key,
  slug            text unique not null,
  name            text not null,
  billing_status  text not null default 'trial',  -- trial|active|past_due|cancelled
  policy          jsonb not null default '{}',
  created_at      timestamptz not null default now()
);
create table org_members (
  org_id          uuid references orgs(id) not null,
  user_id         uuid references users(id) not null,
  role            text not null,  -- owner|admin|member
  primary key (org_id, user_id)
);
-- Publishers gain optional org scoping:
alter table publishers add column org_id uuid references orgs(id);
```

**Rationale:** Single-tenant SaaS gets us paying customers and operational learning fastest. Self-host is real (Phase 1-5 already keep local-first defaults working) but is a separate engineering project — Phase 6.5 spec'd as "package the registry as a Docker compose stack with Postgres + R2-compatible store + Vercel-or-Node runtime." Don't over-build for self-host before SaaS validates the model.

**Revisit if:** First serious sales conversation hinges on self-host. Pull Phase 6.5 forward.

#### D6.2 SSO — WorkOS, scoped per org

**Decision:** WorkOS for SSO (SAML, OIDC against Okta/Azure AD/Google Workspace). Per-org configuration in the org admin UI; member identity provisioning via WorkOS Directory Sync.

**Rationale:** WorkOS abstracts the IdP-of-the-week problem and is the standard SaaS pick. Clerk Orgs is the closest competitor; WorkOS wins on enterprise-features-per-dollar and on the OSS self-host path (Clerk would require ripping out for self-host; WorkOS becomes optional).

**Revisit if:** WorkOS pricing breaks the business model at scale. Plan B: implement SAML directly via `samlify`; significant work.

#### D6.3 Audit log — extend Phase 2's hash-chained pattern

**Decision:** Add `audit_events` table mirroring the data model in `spec/06`. Every state-mutating action (publish, unpublish/yank, member-add/remove, policy-update, token-mint/revoke) emits one row. The hash chain primitive from Phase 2 (`previousEntryId` + `entryChecksum`) is reused at the row level — each `audit_events.entry_checksum` covers the row content plus `previous_entry_id`, forming a tamper-evident chain per org.

**Rationale:** Reusing the Phase 2 primitive means one canonical-JSON serialization + one sha256 routine across the codebase. Tamper-evidence is a real enterprise procurement requirement. Chain-per-org because cross-org queries are rare and per-org chains parallelize trivially.

**Revisit if:** Cross-org cluster integrity becomes a procurement requirement (e.g., a meta-audit story). Plan B: global hash chain in addition to per-org.

#### D6.4 Policy-as-code — JSON schema first, OPA/Rego later

**Decision:** v0.6 extends `agentpack.policy.json` (Phase 5) with org-managed policies that the CLI fetches at install time via `GET /api/orgs/<slug>/policy`. Policy schema stays declarative JSON. OPA/Rego DSL is Phase 6.5+ — when policy logic outgrows declarative constraints.

Org policy adds:

```json
{
  "approvedPublishers": ["agentpack", "stripe", "internal"],
  "approvedPacks": [{ "pack": "internal/audit-checks", "minVersion": "1.2.0" }],
  "deniedAtomTypes": ["hook"],
  "requireSignedPacks": true,
  "allowedProfiles": ["safe", "standard"],
  "installerIdentityRequired": true
}
```

CLI logic: org-policy applied **on top of** user-local policy; the stricter rule wins.

**Rationale:** JSON schema covers ~80% of enterprise policy requirements (allow/deny lists, version floors, profile restrictions). OPA/Rego is right when policy gets program-like — but introducing a DSL prematurely doubles the testing surface. Watch which policies customers ask for; if they look like programs, escalate to Rego.

**Revisit if:** Three customers in a row ask for policies that require if/then logic over pack metadata.

### Phase 6 deliverables

- `apps/registry` — `Org`, `OrgMember`, `AuditEvent` tables + migrations.
- `apps/registry` — `/orgs/<slug>` settings, member, policy, billing pages.
- `apps/registry` — WorkOS integration (env vars: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`).
- `apps/registry` — admin pages for quarantine/block (Phase 4 hooks, now scoped to org admins).
- `packages/cli` — org-policy fetch + merge at install time.
- `packages/cli` — `agentpack audit list --org <slug> --since 2026-01-01`.
- Phase 6 docs at `docs/enterprise.md` and `docs/sso.md`.

### Phase 6 dependencies

- **Hard on Phase 3:** users, publishers, packs all exist.
- **Hard on Phase 5:** CLI policy file primitive exists.
- **Soft on Phase 4:** "requireSignedPacks" is meaningful only if Phase 4 shipped.

### Phase 6 gate

1. `agentpack install` against an org's private pack with an SSO-issued token works end-to-end.
2. Org policy denying `deniedAtomTypes: [hook]` blocks `agentpack install` of a pack containing a hook atom; exit 6.
3. `audit_events` table has rows for every state-mutating action in a representative test scenario; `agentpack audit verify --org <slug> --chain` exits 0.
4. WorkOS SAML against a test Okta tenant signs a user in successfully.
5. Org owner can quarantine a pack version from the UI; CLI install of that version refuses.

---

## Phase 7 — AgentPack integration (v0.7.0 → v1.0.0)

> **Version-label note:** the `v0.7.0` here is the _planned release tag_ for this phase. It is **not** the current in-repo dev version, which is already `0.7.0-dev` while the project sits at Phase-5-shipped (the dev line ran ahead of the phase→version mapping during the off-roadmap iteration work; see `STATUS.md`). Don't read `0.7.0-dev` as "Phase 7."

**Intent.** Make the registry a destination for workflows produced elsewhere — specifically Workgraph (the workflow/context-graph product). A user finishes a workflow in Workgraph, hits "export to AgentPack," and the resulting pack is published to the registry. The network effect: pack catalogue grows from non-hand-authored sources.

**Effort tier estimate:** E5 (the bridge requires deep integration into both products + the trust-graph data model). Probably the v1.0.0 cutover release.

### Decisions

#### D7.1 Export-from-workflow API shape

**Decision:** Workgraph (separate product) calls `POST /api/v1/import/workgraph` on the registry, body shape:

```json
{
  "workgraphWorkflowId": "wf_abc123",
  "publisher": "user-or-org-slug",
  "packMetadata": {
    "id": "user-or-org.workflow-name",
    "name": "Human-readable name",
    "version": "0.1.0",
    "description": "Generated from Workgraph workflow",
    "tags": ["generated", "agentpack"]
  },
  "atoms": [
    {
      "id": "context-bundle",
      "type": "context_pack",
      "files": [{ "path": "context/notes.md", "content": "...", "sha256": "..." }]
    }
  ],
  "provenance": {
    "source": "agentpack",
    "workflowId": "wf_abc123",
    "workflowVersion": "12",
    "exportedAt": "2026-09-01T..."
  },
  "signature": "<cosign signature from the Workgraph service identity>"
}
```

The registry validates, runs through the same publish pipeline as `agentpack publish`, and stores `provenance.source = "agentpack"` so the UI badges it as "imported from Workgraph."

**Rationale:** Mirror the publish flow shape so the existing tests + monitoring extend. The signature is from a Workgraph-service identity, not a user identity (because the user signs into Workgraph, not the registry — but the trust chain still reaches the user via Workgraph's user record).

**Revisit if:** Bidirectional ("edit pack in registry → push back to Workgraph") becomes a requirement. Plan: out of scope for v1.0.0; conversation for v1.1+.

#### D7.2 Trust graph — explicit signals + UI surfacing

**Decision:** Add `trust_signals` table:

```sql
create table trust_signals (
  id              uuid primary key,
  pack_id         uuid references packs(id) not null,
  signal_type     text not null,  -- "downloads_30d" | "stars" | "verified_publisher" | "audited" | "deprecated_via_alternative"
  value           jsonb not null,
  computed_at     timestamptz not null
);
```

UI surfaces a single composite "trust score" (0-100) on pack detail, with the underlying signals expandable. Phase 7 ships these signal types: `downloads_30d` (numeric), `stars` (numeric, user-stars from Phase 6.5+), `verified_publisher` (boolean, publisher-verification flag), `audited` (boolean, set by registry-admin after manual review), `deprecated_via_alternative` (pack_id pointer).

Composite score is computed nightly, cached on `packs.trust_score`. Algorithm: log-scaled downloads + verified-publisher bonus + audit bonus, normalized to 0-100. Not gameable for v0.7 (no user reputation factor — that's Phase 7.5).

**Rationale:** Explicit signals beat a black-box score. Showing why a pack is trusted matters more than the score itself for enterprise procurement. Composite is a convenience, not a primitive.

**Revisit if:** Gaming becomes a problem (download bot networks) — add IP-rate-limited download counts, user-reputation weighting, manual abuse-flag review.

#### D7.3 Agent Commons publishing — one-way export

**Decision:** v0.7 ships a one-way bridge: AgentPack registry → Agent Commons publishing. A pack's publisher can opt-in to "mirror to Agent Commons" via a per-pack flag; on publish, the registry calls Agent Commons' API and the pack appears there with a backlink to the AgentPack registry. Bidirectional (a user editing on Agent Commons writes back to AgentPack registry) is explicitly out of scope.

**Rationale:** One-way export is unambiguous about source of truth (AgentPack registry). Bidirectional has merge-conflict semantics that aren't worth the engineering until both ecosystems are large. The backlink is the network-effect primitive — the mention in Agent Commons surfaces AgentPack to its audience.

**Revisit if:** Agent Commons becomes the dominant authoring surface for community-built packs — then bidirectional becomes worth the cost.

### Phase 7 deliverables

- `apps/registry` — `POST /api/v1/import/workgraph` endpoint + auth via a dedicated Workgraph-service token type.
- `apps/registry` — `trust_signals` table + nightly aggregation cron + UI surfacing on pack detail.
- `apps/registry` — Agent Commons publish-bridge (per-pack opt-in flag).
- Phase 7 docs at `docs/workgraph-import.md`, `docs/trust-graph.md`, `docs/agent-commons.md`.
- v1.0.0 release notes consolidating Phases 1-7.

### Phase 7 dependencies

- **Hard on Phase 3:** publish pipeline, PackVersion table.
- **Hard on Phase 4:** Workgraph-service signatures.
- **Hard on Phase 6:** org model (Workgraph workflows scope to a Workgraph user, who maps to a registry user/org).

### Phase 7 gate

1. A Workgraph workflow exported via `POST /api/v1/import/workgraph` appears in the registry tagged "generated" and "agentpack"; pack detail shows the provenance.
2. The trust-signal composite score renders on pack detail; clicking expands the signals.
3. A pack flagged "mirror to Agent Commons" on publish appears at Agent Commons within the same hour, with an "originally published at registry.agentpack.dev/..." backlink.
4. Cumulative gate (the v1.0.0 cutover): every gate from Phases 3-6 still passes against the v0.7.0 build. No regressions.

---

## Effort tier per phase

The tier (E3–E5) measures **relative complexity and surface area**, not calendar time. This roadmap was originally estimated in solo human-developer weeks; in practice the code is written agentically, so coding effort collapses to a small number of focused agent sessions — the Phase 3 + Phase 5 backend (DB, auth, tokens, publish/read API, seed import, remote-install resolver, cache, policy) was scaffolded in a single `/max` session (see ISA iteration-4). What gates each phase's _ship date_ is its external binding constraint, not the typing.

| Phase   | Tier | Coding effort (agentic)      | Binding constraint on ship date                                                                         |
| ------- | ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| Phase 3 | E5   | done (iteration-4)           | Live infra round-trip: provision Neon + R2 + GitHub-OAuth once, then `scripts/smoke-e2e.sh` passes.     |
| Phase 4 | E4   | done (iteration-9, ISC-318+) | Live Sigstore keyless round-trip from CI + registry-served per-publisher bound-SAN.                     |
| Phase 5 | E3   | shipped (git-source live)    | Registry-served path waits on the Phase 3 infra above; the git-source path already ships.               |
| Phase 6 | E5   | ~1–2 sessions (not started)  | Demand signal — first paying-customer self-host conversation (`Plans/PHASE-6-GATE.md`) + WorkOS wiring. |
| Phase 7 | E5   | est. ~1–2 sessions           | Workgraph product readiness + integration coordination with a separate product.                         |

**The constraint was never the code.** For Phases 3–5 the engineering is written and unit-tested; shipping is gated on standing up live infra once, not on developer-weeks. For Phases 6–7 the gate is a business/partner signal, not coding capacity. The original "~12–19 focused weeks solo" estimate described a human-authored build — it no longer reflects how this project is built or what holds it back.

---

## Sequencing — what to do next

The next five work items, in order:

1. **Stand up `packages/db` with Drizzle + Neon connection** — the schema scaffolding. Start with `users`, `publishers`, `packs`, `pack_versions`, `api_tokens`, `audit_events`. Run a `pnpm db:push` against a Neon staging branch. **This is Phase 3 deliverable #1.**

2. **Wire NextAuth v5 GitHub OAuth into `apps/registry`** — `/api/auth/[...nextauth]`, the GitHub OAuth app, session pages. Test against a personal account before doing the `apps/registry/auth` config polish.

3. **Implement the two-phase publish flow** — `POST /api/publish/init` returns presigned R2 URLs and a `publish_id`, `POST /api/publish/<id>/finalize` verifies SHA-256s and writes rows. Plus the `agentpack publish` CLI subcommand. **Phase 3 gate items #3 and #4 land here.**

4. **Run the seed-import** — `scripts/seed-import.ts`, then refactor `apps/registry/lib/seed.ts` to read from DB instead of JSON. Removing the JSON path from runtime is what makes the gate test "registry detail pages render from DB" honest.

5. **Wire `agentpack install <publisher>/<pack>@<version>`** — Phase 5's first deliverable, which is a check that Phase 3 actually unblocks the remote install ergonomics. Ship as `v0.3.5-rc` before promoting to `v0.5.0`.

After these five, Phase 3 is materially done; pause to ship `v0.3.0`, then start Phase 4 (signatures). Do not start Phase 6 work until Phase 5 has shipped to at least one external user — enterprise contracts hinge on observable adoption.

---

## What this roadmap does NOT propose

- No breaking changes to Phase 1-2 schemas (lockfile v1 stays; manifest `agentpack: '1.0'` stays).
- No new languages or runtimes.
- No abandonment of local-first install — at every phase, `agentpack install ./examples/pr-quality` must still work without network.
- No premature commitment to specific UI mocks for publish/admin flows. Those are design-time decisions; this is the engineering roadmap.
- No v1.0.0 declaration before Phase 7's cumulative gate passes.

---

## Revisit triggers (collected)

For quick reference — the conditions under which the pinned decisions should be reconsidered:

| Decision                  | Revisit trigger                                                |
| ------------------------- | -------------------------------------------------------------- |
| D3.1 Neon                 | Cost >$200/mo at 10K packs, or pooling pinches publish         |
| D3.2 NextAuth             | Non-GitHub IdP becomes important before Phase 6                |
| D3.3 Single Vercel deploy | Cold-start hurts publish, or background jobs outgrow functions |
| D3.4 R2                   | Region-specific storage required by enterprise customer        |
| D3.5 Postgres FTS         | p95 >200ms, or typo-tolerance demanded                         |
| D3.6 Two-phase publish    | Multi-GB packs demand chunked uploads                          |
| D3.7 Reviews deferred     | Publisher demand for social-proof signal before Phase 5        |
| D3.8 Seed one-shot        | Demand for "publish without auth" via git                      |
| D4.1 Sigstore keyless     | Offline signing required (air-gapped)                          |
| D4.3 verify --sig         | Verification latency forces users to disable                   |
| D4.4 Quarantine           | Publishers demand `unpublish` semantics                        |
| D5.1 Resolver             | Cross-pack `dependencies` resolution required                  |
| D5.2 Cache layout         | Cross-platform symlink semantics break Windows                 |
| D5.3 CLI auth             | Multi-registry auth required                                   |
| D5.4 Policy file          | Schema accretion forces split                                  |
| D6.1 SaaS-first           | First sales conversation hinges on self-host                   |
| D6.2 WorkOS               | WorkOS pricing breaks at scale                                 |
| D6.3 Audit chain          | Cross-org integrity story required                             |
| D6.4 Policy JSON          | Three customers want if/then policy logic                      |
| D7.1 Workgraph import     | Bidirectional becomes a requirement                            |
| D7.2 Trust signals        | Download-count gaming detected                                 |
| D7.3 Agent Commons        | Agent Commons becomes dominant authoring surface               |
