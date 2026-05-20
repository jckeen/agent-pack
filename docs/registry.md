# AgentPack Registry (Phase 3)

> **Heads up — you might not need this.** AgentPack's default distribution mechanism is **git**: `agentpack install github:owner/repo@ref` works without any hosted registry. The registry exists as an *optional* convenience for cross-org discovery, schema-validated metadata at index time, admin-side quarantine of compromised versions, and the enterprise self-host path (Phase 6 — 🔒 gated). For everyday OSS publishing, see [the git-source guide](./git-source.md) — that's the leaner path.
>
> Read on if you specifically want a hosted catalog, signed-by-default-served-by-the-host UX, or are evaluating the enterprise unlock.

---

The AgentPack Registry is the hosted catalog that maps `publisher/pack@version`
identities to immutable bytes. Phase 3 (v0.3.0) ships the registry backend
itself — schema, auth, publish flow, search, and read API. Phase 1's pack
specification and Phase 2's install machinery are unchanged.

This is the **engineering reference**. For the wire contract that the CLI and
agents must obey, see `Plans/PROTOCOL.md`.

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│                   apps/registry  (Next.js 15)                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│  │  Web UI     │  │  API routes │  │  NextAuth v5        │   │
│  │  /          │  │  /api/      │  │  /api/auth/         │   │
│  │  /packs     │  │  packs/...  │  │  GitHub OAuth       │   │
│  │  /docs      │  │  publish/   │  │                     │   │
│  │  /validate  │  │  search     │  │                     │   │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘   │
└─────────┼────────────────┼────────────────────┼──────────────┘
          │                │                    │
          ▼                ▼                    ▼
   ┌──────────────────────────────┐   ┌────────────────────┐
   │   packages/db (Drizzle)      │   │  Cloudflare R2     │
   │                              │   │                    │
   │  users, publishers, packs,   │   │  manifest.yaml,    │
   │  pack_versions, atoms,       │   │  atom file bytes,  │
   │  pack_files, compatibilities,│   │  readme.md         │
   │  api_tokens, publishes,      │   │                    │
   │  reviews, audit_events,      │   │                    │
   │  accounts/sessions/...       │   │                    │
   └──────────────┬───────────────┘   └────────────────────┘
                  │
                  ▼
         ┌────────────────────┐
         │  Postgres (Neon)   │
         │  prod branch       │
         └────────────────────┘
```

---

## Schema

Authoritative definitions live in `packages/db/src/schema/`. The full DDL is
emitted into `packages/db/migrations/`.

Key tables (see `Plans/PROTOCOL.md` § 4 for the full column list):

| Table | Purpose |
|---|---|
| `users` | NextAuth-managed; one row per GitHub identity |
| `publishers` | A namespace for packs (`agentpack`, `stripe`, an org slug) |
| `publisher_members` | Many-to-many users↔publishers with `owner|maintainer` role |
| `packs` | One per `<publisher>/<pack>` slug; has `latest_version_id` pointer + `search` tsvector |
| `pack_versions` | Immutable. `status` is mutable (`published|deprecated|yanked|quarantined|blocked`) |
| `atoms` | Per-version atom registry (id, type, risk_level, metadata) |
| `pack_files` | Per-version blob registry (`path`, `sha256`, `bytes`, `r2_key`) |
| `compatibilities` | Per-version × target platform compatibility status |
| `api_tokens` | CLI tokens — `sha256(token)` stored, never the token itself |
| `publishes` | Two-phase publish state — pending/aborted/completed |
| `reviews` | Schema-only in v0.3; POST returns 501 |
| `audit_events` | Phase 6-reserved hash-chained log |
| `accounts`, `sessions`, `verification_tokens` | Managed by `@auth/drizzle-adapter` |

The `packs.search` column is a Postgres `tsvector` generated from
`(name, description, tags)` with weights A/B/C. A GIN index named
`packs_search_idx` covers `to_tsquery` queries.

### Operating the DB

```bash
# Push schema to a DATABASE_URL-pointed Postgres
pnpm db:push

# Generate a new migration after schema changes
pnpm db:generate

# Drizzle Studio
pnpm --filter @agentpack/db db:studio
```

The recommended deployment is **Neon Postgres** with `pool_mode=transaction`
via the bundled PgBouncer. Free-tier cold-start hurts publish latency — keep
one always-warm branch pinned to prod.

---

## Auth

NextAuth v5 (`next-auth@5.0.0-beta.31`) is the App-Router-native option, used
with the Drizzle adapter (`@auth/drizzle-adapter@1.11.2`).

| Flow | Surface |
|---|---|
| GitHub OAuth sign-in (web) | `/api/auth/signin` (NextAuth) |
| CLI device-code login | `/api/cli/auth/init` → user signs in on web → `/api/cli/auth/approve` → `/api/cli/auth/poll` |
| Bearer-token auth (CLI publish, install of private packs) | `Authorization: Bearer agp_live_...` against `/api/publish/...`, `/api/me`, etc. |

### Token format

```
agp_live_<32-hex-chars>
└─ prefix 9 chars ─┘└── body 32 chars ──┘
```

- Stored as `sha256(token)` (hex lowercase, 64 chars) in `api_tokens.token_sha256`.
- First 12 chars of the full token (`agp_live_xxx`) retained in `token_prefix` for UI display.
- Scopes (jsonb array): `read:packs`, `read:private`, `publish:packs`, `admin:registry`. Scoped forms allowed: `publish:packs@<publisher>`, `read:private@<publisher>`.
- `last_used_at` updated fire-and-forget on every verified hit.
- `revoked_at` is the soft-delete signal. Verification returns null when set.

CLI display **always** masks: `agp_live_xxxx…<last-4>`. Never log the full token outside the one-time creation response.

---

## Publish flow

Two-phase, presigned-PUT, finalize:

```
1. Client → POST /api/publish/init
   { publisher, pack, version, manifestSha256, files: [{path, sha256, bytes}], metadata }

2. Server: verify token → check version doesn't exist (409 if it does) →
   insert publishes row (pending, expires_at = now+24h) →
   return { publishId, expiresAt, presignedUploads: [{path, url, headers}] }

3. Client: for each presignedUpload, PUT bytes to url with the headers.

4. Client → POST /api/publish/<publishId>/finalize

5. Server: for each declared file, HEAD R2 object → verify bytes match declared
   size (size_mismatch → 422 with mismatched[]) →
   transaction: insert pack (if new), pack_versions, atoms, pack_files,
   compatibilities → update packs.latest_version_id if greater semver →
   mark publishes.status = completed →
   return { packId, versionId, url }
```

**Why HEAD-only at finalize:** R2 HEAD returns size + ETag without egressing
bytes. Mismatched size aborts the publish. Full server-side re-hashing is
**Phase 4 work** (cosign provenance background worker) — same-size content
forgery is caught later by Phase 4's signature verification, which signs over
the per-file `pack_files.sha256` digest list.

Aborted and `pending > 24h` publishes are GC'd nightly. Re-publishing the
same version returns 409 always (immutable versions).

---

## Read API

| Route | Method | Returns |
|---|---|---|
| `/api/packs` | GET | `{ packs: RegistryPack[], total }` — paged, tag/risk filters |
| `/api/packs/:publisher/:pack` | GET | `RegistryPack` with versions list |
| `/api/packs/:publisher/:pack/versions/:version` | GET | `RegistryVersion` with files[] |
| `/api/packs/:publisher/:pack/versions/:version/manifest.yaml` | GET | raw manifest bytes from R2 |
| `/api/packs/:publisher/:pack/versions/:version/atoms/:atomId/:path` | GET | raw atom-file bytes from R2 |
| `/api/search?q=...` | GET | `{ results: RegistrySearchResult[] }` — Postgres FTS |
| `/api/packs/:publisher/:pack/reviews` | GET | seed reviews; POST → 501 |
| `/api/me` | GET (bearer) | `{ id, username, publisherSlugs }` |

The byte-streaming routes (manifest, atom-file) set
`Cache-Control: public, max-age=31536000, immutable` — versions are immutable
so the cache is too. Quarantined versions return 451 instead of streaming.

---

## Storage

**Cloudflare R2**, S3-compatible. Bucket layout:

```
/<publisher>/<pack>/<version>/manifest.yaml
/<publisher>/<pack>/<version>/readme.md          (optional)
/<publisher>/<pack>/<version>/atoms/<atomId>/<file-path>
```

Zero egress pricing — `agentpack install publisher/pack` reads from R2 on every
fetch; Vercel Blob's egress at scale would be expensive. Phase 6 self-host
customers can swap in their own S3-compatible store via env var.

Required env vars:

- `R2_ENDPOINT` — `https://<account-id>.r2.cloudflarestorage.com`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET` — `agentpack-artifacts-prod` for prod, `agentpack-artifacts-staging` for preview

When R2 env vars are unset, the registry boots but publish/manifest/atom-file
routes return 503 `{ error: "r2_unconfigured" }` — useful for local dev with
DB-only fixtures.

---

## Search

Postgres FTS via `to_tsquery` / `plainto_tsquery` against `packs.search`.
Weights: name (A) > description (B) > tags (C). Ranking via `ts_rank_cd`.

At <1000 packs, p95 < 100ms locally. Revisit if cross-field relevance or
typo-tolerance becomes the bottleneck — Plan B is Meilisearch self-host.

---

## Reviews

Schema lands in v0.3.0; `POST` returns 501. UGC moderation is real engineering
(spam, manipulation, abuse) and doesn't belong on the critical path for "users
can publish and install." Locking the schema now avoids migration churn when
v0.3.5 (revisit window) actually ships POST.

---

## Seed migration

`scripts/seed-import.ts` reads `seed/seed-packs.json` and INSERTs any rows that
don't exist (checked by `(publisher_slug, pack_slug, version)`). Idempotent —
safe to re-run after partial failure. Run it once after `pnpm db:push`:

```bash
DATABASE_URL='postgres://...' pnpm seed:import
```

After v0.3.0 ships, `seed/seed-packs.json` stays in the repo as historical
documentation but is removed from the runtime read path — the registry web
app reads from DB only when `DATABASE_URL` is set; the JSON fallback is
preserved for fully-local dev.

---

## Local development

Minimum local stack:

```bash
# 1. Start Postgres locally (or use Neon, or skip and use JSON fallback)
docker run -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16

# 2. Set env
export DATABASE_URL='postgres://postgres:dev@localhost:5432/postgres'
export AUTH_SECRET='dev-secret-not-for-prod'

# 3. Apply schema + seed
pnpm db:push
pnpm seed:import

# 4. Boot
pnpm dev
```

Without `DATABASE_URL`, the registry boots in JSON-fallback mode — `/packs` and
`/packs/[publisher]/[slug]` render from `seed/seed-packs.json` (ISC-223). The
publish + token routes return 503 in that mode.

---

## Deferred to later phases

- **Phase 4** — Sigstore cosign keyless signing; `pack_versions.cosign_signature` column; CLI `agentpack verify --sig`. Schema slots in `LockfileV1.signatures` already reserved.
- **Phase 5** — `agentpack install publisher/pack@version` (remote fetch). Phase 5 lands the CLI side; this registry already serves the API it needs.
- **Phase 6** — Orgs, SSO via WorkOS, audit log chain wiring, policy-as-code.
- **Phase 7** — AgentPack workflow import; trust-signal aggregation; Agent Commons publish bridge.
