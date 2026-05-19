# AgentPack Protocol — Phase 3 + Phase 5 wire contract

This document pins the wire contract for the AgentPack registry (Phase 3) and the
remote-install CLI (Phase 5). It is the source of truth for the names, shapes, and
trust-model decisions that the three iteration-4 worktree agents inherit.

Worktree agents MUST NOT invent alternative names for any field, error code, or
table column listed here. If a name is missing or ambiguous, surface it to the
primary agent — do not extrapolate.

---

## 1. Token format (Phase 3 auth)

| Property | Value |
|---|---|
| Prefix | `agp_live_` |
| Body | 32 hex chars (16 random bytes, lowercased) |
| Full shape | `agp_live_[0-9a-f]{32}` |
| Total length | 41 chars |
| Header | `Authorization: Bearer <token>` |
| Storage | `sha256(token-as-utf-8-bytes)`, hex lowercased (64 chars), stored in `api_tokens.token_sha256` |
| Prefix retained | First 12 chars (`agp_live_xxx`) in `api_tokens.token_prefix` for UI display |
| Scopes (jsonb array) | `read:packs`, `read:private`, `publish:packs`, `admin:registry` |
| Scope expansion | `publish:packs@<publisher>` for publisher-scoped tokens; `read:private@<publisher>` for org-scoped private reads |

**Verification flow:**
1. Read `Authorization` header; require `Bearer ` prefix.
2. Compute `sha256(token)`.
3. Lookup `api_tokens` by hash; reject if `revoked_at IS NOT NULL`.
4. Update `last_used_at` fire-and-forget.
5. Return `{ userId, publisherIds, scopes }`.

**Display masking** (CLI must apply): print `agp_live_xxxx…<last-4>` only — never the full token.

---

## 2. Publish trust model

The two-phase publish flow trusts the client's declared `sha256` for blob upload
authorization, then **re-verifies size + presence** at finalize via an R2 HEAD.
Full server-side re-hashing is **Phase 4 work** (cosign provenance background
worker). This is documented as a known limitation; the lockfile's per-file
`sha256` remains the integrity primitive for the install path.

**Why HEAD-only at finalize (MVP):** R2 HEAD returns object size + ETag without
egressing bytes. Mismatched size → 422 abort. Same-size content forgery is
caught later by Phase 4's signature verification (any tampered blob breaks the
cosign signature over the lockfile's `outputs` digest list).

**Why not full re-hash now:** ~10s+ per multi-atom pack, blocks the request
thread, and the security-equivalent guarantee arrives with Phase 4 signatures
anyway. The two-phase flow is structured so a background worker can re-hash
post-finalize without changing the wire contract.

---

## 3. Wire shapes (zod schemas live in `packages/core/src/protocol/`)

### PublishInitRequest

```typescript
{
  publisher: string,        // slug, matches /^[a-z0-9-]+$/
  pack: string,             // slug
  version: string,          // semver, no leading 'v'
  manifestSha256: string,   // sha256 of canonical AGENTPACK.yaml bytes (UTF-8, LF line endings)
  files: Array<{
    path: string,           // relative to pack root, POSIX separators, no '..'
    sha256: string,         // lowercase hex
    bytes: number,          // non-negative integer
    atomId?: string,        // if file is part of an atom body
  }>,
  metadata: {
    name: string,
    description: string,
    tags: string[],
    compatibilities: Array<{ target: PlatformTarget, status: CompatibilityStatus }>,
  },
}
```

### PublishInitResponse (200)

```typescript
{
  publishId: string,           // uuid
  expiresAt: string,           // ISO-8601, 24h from now
  presignedUploads: Array<{
    path: string,
    url: string,               // R2 presigned PUT URL
    headers: Record<string, string>,  // include `x-amz-meta-sha256` for integrity audit
  }>,
}
```

### Error responses

| Status | Body shape | Cause |
|---|---|---|
| 401 | `{ error: "unauthorized" }` | Missing/invalid bearer token |
| 403 | `{ error: "forbidden", reason: "scope_mismatch" }` | Token lacks `publish:packs` or wrong publisher |
| 409 | `{ error: "version_exists", existing: { publishedAt, publishedBy } }` | `(publisher, pack, version)` already published |
| 422 | `{ error: "validation", issues: zod.issues }` | Body shape rejected |

### PublishFinalizeRequest

```typescript
{ publishId: string }
```

### PublishFinalizeResponse (200)

```typescript
{
  packId: string,
  versionId: string,
  url: string,            // https://registry.agentpack.dev/packs/<publisher>/<pack>/<version>
}
```

### PublishFinalizeMismatchResponse (422)

```typescript
{
  error: "size_mismatch",
  mismatched: Array<{
    path: string,
    expected: number,       // bytes from PublishInitRequest
    got: number | "missing",
  }>,
}
```

### Expired publish (410 Gone)

```typescript
{ error: "publish_expired", publishId: string }
```

### RegistryPack (GET /api/packs/:publisher/:pack)

```typescript
{
  publisher: string,
  pack: string,
  description: string,
  tags: string[],
  versions: Array<{ version: string, publishedAt: string, status: VersionStatus }>,
  latestVersion: string | null,    // null if no `published` versions
}
```

### RegistryVersion (GET /api/packs/:publisher/:pack/versions/:version)

```typescript
{
  publisher: string,
  pack: string,
  version: string,
  status: VersionStatus,
  manifestSha256: string,
  publishedAt: string,
  files: Array<{
    path: string,
    sha256: string,
    bytes: number,
    atomId?: string,
  }>,
}
```

### VersionStatus

```typescript
"published" | "deprecated" | "yanked" | "quarantined" | "blocked"
```

### PlatformTarget (re-exported from existing schema)

```typescript
"claude-code" | "codex" | "cursor" | "chatgpt" | "generic"
```

### CompatibilityStatus

```typescript
"supported" | "partial" | "experimental" | "unsupported"
```

---

## 4. DB column names (pinned for `packages/db`)

Table names use `snake_case` (Postgres convention). Drizzle column names match.
Worktree W1 implements full Drizzle schema against these names. Worktree W2
imports table objects (not raw SQL) from `@agentpack/db`.

| Table | Key columns |
|---|---|
| `users` | `id (uuid)`, `github_id (text unique)`, `username (text)`, `email (text)`, `avatar_url (text)`, `created_at (timestamptz)` |
| `publishers` | `id (uuid)`, `slug (text unique)`, `display_name (text)`, `verified (boolean)`, `created_at` |
| `publisher_members` | `publisher_id (fk users.id... actually publishers.id)`, `user_id (fk users.id)`, `role (text: owner\|maintainer)`, `created_at` — PK `(publisher_id, user_id)` |
| `packs` | `id (uuid)`, `publisher_id (fk publishers.id)`, `slug (text)`, `description (text)`, `tags (text[])`, `latest_version_id (uuid nullable fk pack_versions.id)`, `created_at`, `search (tsvector generated)` |
| `packs` unique | `(publisher_id, slug)` |
| `pack_versions` | `id (uuid)`, `pack_id (fk packs.id)`, `version (text)`, `status (text default 'published')`, `manifest_sha256 (text)`, `manifest_r2_key (text)`, `readme_r2_key (text nullable)`, `published_at`, `published_by (fk users.id)` |
| `pack_versions` unique | `(pack_id, version)` |
| `atoms` | `id (uuid)`, `pack_version_id (fk pack_versions.id)`, `atom_id (text)`, `type (text)`, `risk_level (text)`, `metadata (jsonb)` |
| `atoms` unique | `(pack_version_id, atom_id)` |
| `pack_files` | `id (uuid)`, `pack_version_id (fk pack_versions.id)`, `atom_id (text nullable)`, `path (text)`, `sha256 (text)`, `bytes (integer)`, `r2_key (text)` |
| `pack_files` index | `(pack_version_id, path)` |
| `compatibilities` | `pack_version_id`, `target (text)`, `status (text)` — PK `(pack_version_id, target)` |
| `api_tokens` | per D3.2 — `id`, `user_id`, `publisher_id (nullable)`, `name`, `token_prefix`, `token_sha256 (unique)`, `scopes (jsonb)`, `last_used_at`, `created_at`, `revoked_at` |
| `publishes` | `id (uuid)`, `publisher_slug (text)`, `pack_slug (text)`, `version (text)`, `status (text: pending\|aborted\|completed)`, `expires_at`, `created_by (fk users.id)`, `pack_id (nullable fk packs.id)`, `presigned_files (jsonb)`, `created_at` |
| `reviews` | `id (uuid)`, `pack_version_id`, `user_id`, `rating (smallint 1-5)`, `body (text)`, `created_at` |
| `audit_events` (Phase 6 reserved) | `id`, `org_id (nullable)`, `actor_user_id`, `action (text)`, `target_type`, `target_id`, `previous_entry_id (nullable fk audit_events.id)`, `entry_checksum (text)`, `payload (jsonb)`, `created_at` |

---

## 5. Exit codes (CLI)

Pinned for all iteration-4 commands. Workflow scripts depend on these:

| Code | Meaning | Phase |
|---|---|---|
| 0 | Success | — |
| 1 | Generic CLI error (usage, IO, network) | — |
| 2 | Drift detected (`verify` reports modified/missing files) | Phase 2 |
| 3 | History chain integrity broken | Phase 2 |
| 4 | Signature verification failed | Phase 4 |
| 5 | Pack is unsigned and `--sig` was required | Phase 4 |
| 6 | Policy violation (`agentpack.policy.json` enforcement) | Phase 5 |
| 7 | Integrity error — fetched bytes' sha256 ≠ registry-declared | Phase 5 |
| 9 | Conflict — version already exists on publish | Phase 3 |

---

## 6. Cache layout (Phase 5)

```
~/.agentpack/
├── credentials.json       # { registries: { <url>: { token, scopes } } }, 0o600
├── policy.json            # optional user-wide default policy
└── cache/
    ├── blobs/
    │   └── <sha[0..2]>/<sha>     # content-addressed; sha = lowercase hex sha256
    ├── manifests/
    │   └── <publisher>/<pack>/<version>.yaml
    └── packs/
        └── <publisher>/<pack>/<version>/   # symlinks into blobs/
```

**Cache key:** lowercase hex sha256 of the blob bytes, matching `pack_files.sha256`.
**Lookup:** `blobs/<sha[0..2]>/<sha>` exists → cache hit.
**Miss flow:** fetch URL → write to a temp file → verify sha256 → atomic rename
into `blobs/<sha[0..2]>/<sha>`. If sha mismatch, delete temp + raise
`IntegrityError` (exit 7).

---

## 7. `agentpack.policy.json` v1 (Phase 5)

```typescript
{
  policyVersion: 1,
  registries: {
    allowed: string[],
    default: string,
  },
  packs: {
    allowedPublishers?: string[],
    blockedPacks?: string[],
  },
  install: {
    requireSignature?: boolean,
    allowedProfiles?: ProfileName[],
    deniedAtomTypes?: AtomType[],
  },
  verify: {
    onInstall?: "off" | "warn" | "required",
    chain?: "off" | "warn" | "required",
  },
}
```

**Enforcement order:** when policy denies, exit 6 with the violation reason. Phase 6
will overlay org-scoped policy on top (stricter wins).

---

## 8. NextAuth v5 (Auth.js) configuration

`apps/registry` is Next.js App Router; NextAuth v5 (`next-auth@5.0.0-beta.31`)
is the App-Router-native pick (uses `auth()` from `lib/auth.ts` directly in
React Server Components). GitHub OAuth provider is the only login route in
Phase 3. The Drizzle adapter (`@auth/drizzle-adapter@1.11.2`) wires NextAuth's
session/user tables on top of the schema defined by `packages/db`.

**Tables managed by NextAuth+Drizzle adapter:** `accounts`, `sessions`,
`verification_tokens` — these are SEPARATE from the AgentPack registry tables
listed in section 4. The adapter creates them; we don't author them.

**Session shape (extended):**
```typescript
{
  user: { id, name, email, image },
  publisherSlugs: string[],  // populated in session callback from publisher_members
}
```

---

## 9. Dependencies pinned (iteration-4 protocol commit)

| Package | Version | Where |
|---|---|---|
| `drizzle-orm` | 0.45.2 | `packages/db` |
| `drizzle-kit` | 0.31.10 | root devDep (for `pnpm db:push`) |
| `postgres` | 3.4.9 | `packages/db` |
| `@neondatabase/serverless` | 1.1.0 | `packages/db` |
| `next-auth` | 5.0.0-beta.31 | `apps/registry` |
| `@auth/drizzle-adapter` | 1.11.2 | `apps/registry` |
| `@aws-sdk/client-s3` | 3.1049.0 | `apps/registry` |
| `@aws-sdk/s3-request-presigner` | 3.1049.0 | `apps/registry` |

Verified against npm registry at protocol-commit time.

---

## 10. Anti-criteria for worktree agents

These behaviors are explicitly out of bounds for any agent extending this protocol:

- **No new error codes** outside Section 5. If you need one, surface to primary agent.
- **No alternative table names.** Use Section 4 verbatim.
- **No alternative token format.** Section 1 is law.
- **No silent fallback** when a wire shape doesn't match — return 422 with zod issues.
- **No re-implementing canonical JSON.** `packages/core` already exports `canonicalJson` from the Phase 2 install module — reuse it.
- **No editing `packages/core/src/index.ts` or `packages/cli/src/index.ts`** from a worktree. Those are the primary agent's wire-up surface; agents append their exports to a workstream-local index file and the primary agent merges.
