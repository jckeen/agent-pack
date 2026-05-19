# `workgraph publish` — publishing to the registry

`workgraph publish` uploads a local pack directory to the Workgraph Registry.
The pack becomes installable by anyone with `workgraph install <publisher>/<pack>@<version>`.

This document is the operator/developer reference. The wire contract lives in
`Plans/PROTOCOL.md`; the registry-side mechanics live in `docs/registry.md`.

---

## Quickstart

```bash
# 1. Authenticate (one-time per machine)
workgraph login
# → opens browser to https://registry.workgraph.dev/cli/auth
# → enter the user code shown in your terminal
# → credentials written to ~/.workgraph/credentials.json (mode 0600)

# 2. Verify you're authenticated
workgraph whoami
# → Logged in as alice (publisher: workgraph, acme)

# 3. Publish
cd path/to/your/pack
workgraph publish
# → reads AGENTPACK.yaml, computes per-file hashes
# → summary: workgraph/pr-quality@0.1.0, 12 files, 84.2 KB → registry.workgraph.dev
# → [y/N] confirmation (use --yes to skip)
# → uploads each file via presigned R2 PUT
# → finalizes
# → Published workgraph/pr-quality@0.1.0 → https://registry.workgraph.dev/packs/workgraph/pr-quality/0.1.0
```

---

## Authentication

### Login flow (`workgraph login`)

Device-code OAuth:

1. CLI calls `POST /api/cli/auth/init` → receives `{ deviceCode, userCode, verificationUrl, expiresAt, interval }`.
2. CLI prints the user code and opens `verificationUrl` in the user's default browser (`xdg-open`/`open`/`start`).
3. User signs in via GitHub OAuth, enters the user code on the registry's web UI, approves the request.
4. CLI polls `POST /api/cli/auth/poll` every `interval` seconds. On `complete`, the response carries the bearer token + user identity.
5. CLI writes `~/.workgraph/credentials.json` with mode `0o600` on POSIX.

### Credentials file

```json
{
  "registries": {
    "https://registry.workgraph.dev": {
      "token": "wgp_live_...",
      "scopes": ["read:packs", "publish:packs"],
      "username": "alice"
    }
  }
}
```

One token per registry. `--registry <url>` flag selects which entry to use.

### Token scopes

| Scope | Allows |
|---|---|
| `read:packs` | Fetching public manifests + atoms (rarely needed — those routes are unauthenticated) |
| `read:private` | Fetching private packs (`visibility: private` on the registry row). Scoped form: `read:private@<publisher>` |
| `publish:packs` | Publishing new versions to **any** publisher you have membership in. Scoped form: `publish:packs@<publisher>` — narrow to a single publisher |
| `admin:registry` | Registry-administrative actions (quarantine/block versions). Not granted by default — registry admins only |

The default scope granted by `workgraph login` is `read:packs publish:packs` — the
minimum for the round-trip.

### Manual token management

```bash
# Mint a new token (requires logged-in session in the browser; the CLI also has shortcuts)
workgraph tokens create --name "ci-publish" --scopes publish:packs@workgraph

# List your tokens
workgraph tokens list

# Revoke
workgraph tokens revoke <token-id>
```

The full token value is **shown once** at creation and never again. Store it in
your CI secret manager (GitHub Actions, etc.).

---

## Publishing

### Command shape

```
workgraph publish [path] [options]

Arguments:
  path                    Pack directory (default: current dir)

Options:
  --registry <url>        Override registry URL (default: https://registry.workgraph.dev)
  --yes                   Skip the interactive confirmation prompt
```

### What gets uploaded

`workgraph publish` walks the resolved atom tree and uploads:

- `AGENTPACK.yaml` (the manifest) — verified by `manifestSha256` of canonical bytes.
- `README.md` (if present) — referenced as `metadata.readme`.
- For each atom, every file the atom references — skill body files, hook scripts, MCP server source, command stubs, etc.

Per-file `sha256` + `bytes` are computed locally and sent in the `init` request.
The registry presigns one R2 PUT URL per file with the expected hash header
(`x-amz-meta-sha256`). The CLI then PUTs each file's bytes. At `finalize`, the
registry verifies the uploaded blob's size matches the declared size; on
mismatch the publish aborts with 422 (no DB rows written).

**The CLI sends only structural metadata** — no env vars, no local secrets, no
files outside the pack directory (ISC-263).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Published successfully |
| 1 | Generic error (network, IO, missing manifest) |
| 9 | `409 version_exists` — that `(publisher, pack, version)` already published |

On 409 the CLI prints the existing version's `publishedAt` and `publishedBy`
metadata, so the user can decide to bump the version.

### Validation errors

If the registry returns 422 `{ error: "validation", issues }`, the CLI prints
the zod issues with paths. Most common causes:

- Invalid publisher/pack slug (must match `/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/`).
- Non-semver `version` (e.g. `v0.1.0` — strip the leading `v`).
- File path contains `..` or absolute path — must be project-relative POSIX.
- `manifestSha256` doesn't match the registry's recompute of the uploaded bytes.

### Size-mismatch errors

If the registry returns 422 `{ error: "size_mismatch", mismatched }` at finalize,
one of the PUT uploads either didn't complete or wrote a different number of
bytes than declared. The CLI prints the offending paths. Retry the publish —
the registry GC will clean up the abandoned presigned blobs nightly.

---

## CI publishing

```yaml
# .github/workflows/publish.yml
name: Publish
on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build

      - name: Publish to Workgraph Registry
        env:
          WORKGRAPH_TOKEN: ${{ secrets.WORKGRAPH_PUBLISH_TOKEN }}
        run: pnpm -r workgraph publish --yes
```

Mint a CI-scoped token via `workgraph tokens create --name "github-publish" --scopes publish:packs@<publisher>`.
Store as a repo secret. The CLI reads `WORKGRAPH_TOKEN` from env when no
credentials file is present.

---

## What `publish` does NOT do (yet)

- **No re-publishing.** Same `(publisher, pack, version)` returns 409 always. Bump the version.
- **No yank/unpublish.** Versions are immutable; status is mutable. Yank is a publisher self-service action (web UI in v0.4); unpublish is a separate audit-trail operation (Phase 6).
- **No signing.** v0.3 publishes are unsigned. Phase 4 adds Sigstore keyless signing — same `publish` command, plus a Fulcio round-trip after finalize. The lockfile slot is already reserved (`signatures.manifest`).
- **No multi-file chunked uploads.** Each file is one PUT. Multi-GB packs are slow but work. Phase 3.5 or 4 will add chunked uploads.
- **No `--from-git` source-pinning.** A future Phase 3.5 feature for unauthenticated project-level publishing of seed packs.

See `Plans/ROADMAP.md` for the full revisit-trigger list.
