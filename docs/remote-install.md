# Remote install (Phase 5)

`workgraph install <publisher>/<pack>[@<version>]` fetches a pack from the
Workgraph Registry, verifies its integrity, and applies the same
`planInstall → applyInstall` pipeline that local-path install uses (Phase 2).

This document is the operator/developer reference. The wire contract is in
`Plans/PROTOCOL.md`; the registry side is in `docs/registry.md`.

---

## Quickstart

```bash
# Install latest stable
workgraph install workgraph/pr-quality --target claude-code --profile safe

# Install a specific version
workgraph install workgraph/pr-quality@0.1.0 --target claude-code --profile safe

# Dry-run (no writes)
workgraph install workgraph/pr-quality --target claude-code --profile safe --dry-run

# Install from a non-default registry
workgraph install workgraph/pr-quality --registry https://internal.example.com
```

The local-path install (`workgraph install ./path/to/pack`) is unchanged — the
remote branch only fires when the argument matches `<publisher>/<pack>[@<version>]`.

---

## Identity grammar

```
<publisher>/<pack>[@<version>]

publisher  — slug: [a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?
pack       — slug
version    — semver (e.g. 1.2.3 or 1.2.3-beta.1). Optional. Default: latest stable.
```

When `@version` is omitted, the CLI calls `GET /api/packs/<publisher>/<pack>`
and picks the highest semver version that:

1. Has `status = 'published'`.
2. Has no pre-release tag (so `1.0.0-rc.1` is skipped in favor of `0.9.0`).
3. Is not yanked, deprecated, quarantined, or blocked.

If no published-non-prerelease version exists, the install errors with exit
1 and a message naming the available pre-release versions.

---

## Fetch pipeline

```
1. Resolve identity → version (call /api/packs/.../ if @version missing).
2. GET /api/packs/<pub>/<pack>/versions/<ver> → RegistryVersion {files[], manifestSha256}.
3. Cache lookup: ~/.workgraph/cache/blobs/<sha[0..2]>/<sha> per file. Hit → reuse. Miss → fetch.
4. For each cache miss: GET /api/packs/.../atoms/<atomId>/<path> → verify sha256(body) === expected → write to cache atomically.
5. Materialize the cached blobs into a temp pack directory.
6. Feed the temp dir to existing planInstall({ packRoot, target, profile, projectRoot }).
7. Existing applyInstall, manifest write, lockfile, history → unchanged.
```

The same Phase 2 invariants hold:

- Realpath containment: writes stay inside `projectRoot`.
- WAL: `install_begin` first, `install_commit` last; recovery sweep on next CLI run.
- Lockfile: per-atom + per-file sha256s; deterministic; signature slot empty until Phase 4.

---

## Cache

```
~/.workgraph/cache/
├── blobs/
│   └── <sha[0..2]>/<sha>      # content-addressed; key is sha256 of bytes
├── manifests/
│   └── <publisher>/<pack>/<version>.yaml
└── packs/
    └── <publisher>/<pack>/<version>/   # symlinks into blobs/ (or copies on Windows)
```

The cache key is the file's **sha256**. Same atom shared across 10 packs costs
disk once. `~/.workgraph/cache/blobs/<sha[0..2]>/<sha>` is the source of truth;
the `packs/` view is human-readable and rebuilt from the blob store on demand.

### Cache commands

```bash
# How much disk?
workgraph cache size
# → 142.3 MB across 1,847 blobs

# Prune blobs older than 30 days (default)
workgraph cache prune
workgraph cache prune --max-age 7d

# Clear everything (asks for confirm)
workgraph cache clear
```

### Cache safety

- `workgraph cache prune` never deletes outside `~/.workgraph/cache/blobs/`. Every candidate path is realpath-resolved and must be inside the blob dir (ISC-246, ISC-264).
- Writes are atomic: bytes go to a `<sha>.tmp` file, sha256 is verified against the expected hash, only then `rename` into the final path. Mismatched bytes raise `IntegrityError` (exit 7) and the temp is deleted.
- Re-fetching is idempotent: same `sha` → same path → no-op.

---

## Authentication

| Pack visibility | Token required? |
|---|---|
| Public | No |
| Private | Yes — `read:private` scope or `read:private@<publisher>` |

Tokens are read from `~/.workgraph/credentials.json` (managed by `workgraph login`).
The CLI sends `Authorization: Bearer <token>` if present; the registry decides
whether the scope is sufficient.

Override token from env: `WORKGRAPH_TOKEN=wgp_live_...` — useful in CI.

---

## Exit codes

| Code | Cause |
|---|---|
| 0 | Installed successfully |
| 1 | Generic error (network, missing version, IO) |
| 2 | Drift detected post-install during verify (existing Phase 2 behavior) |
| 6 | Policy violation (`workgraph.policy.json` enforcement — see `docs/policy.md`) |
| 7 | **IntegrityError** — fetched bytes' sha256 didn't match what the registry declared |

Exit 7 is the supply-chain integrity signal. If you see it repeatedly against
a single pack, the registry may be compromised or the lockfile contract is
broken — file a security report.

---

## Policy

If `workgraph.policy.json` is present at the project root, the install path
loads it (`loadPolicy`) and enforces it (`enforcePolicy`) before any bytes are
written. Common rules:

```json
{
  "policyVersion": 1,
  "registries": {
    "allowed": ["https://registry.workgraph.dev"],
    "default": "https://registry.workgraph.dev"
  },
  "install": {
    "requireSignature": true,
    "allowedProfiles": ["safe", "standard"],
    "deniedAtomTypes": ["hook"]
  }
}
```

Violation → exit 6 with a friendly diagnostic. See `docs/policy.md` for the
full schema + enforcement order.

---

## Verifying what landed

After `workgraph install workgraph/pr-quality@0.1.0 ...`, the project has:

- The files the pack's chosen adapter+profile rendered (Phase 2 behavior).
- `.workgraph/installed/workgraph.pr-quality.json` — the install manifest.
- `AGENTPACK.lock` at project root — the lockfile with per-atom + per-file sha256s. **This should be committed.**
- `.workgraph/history.jsonl` entries for the install (`install_begin` + `install_commit`).

```bash
# Check drift
workgraph verify workgraph.pr-quality
# exit 0 = clean, exit 2 = drift, exit 3 = chain integrity broken
```

When Phase 4 lands, `workgraph verify --sig` will additionally verify the
Sigstore signature over the lockfile's per-file digest list.

---

## What remote install does NOT do

- **No transitive dep resolution.** The lockfile reserves a `dependencies` slot but Phase 5 doesn't populate it. Cross-pack dependencies (Phase 7+) require a SAT-style resolver.
- **No offline-first auth refresh.** If your token expired, the first fetch returns 401 and you re-run `workgraph login`.
- **No streaming install.** Files are fetched + verified + cached before any write to the project. This is a deliberate ordering — better to fail fast on a hash mismatch than to half-write the project tree.
- **No `--continue` after failure.** A partial install rolls back via Phase 2's WAL recovery on the next CLI run.

See `Plans/ROADMAP.md` for the full revisit-trigger list.
