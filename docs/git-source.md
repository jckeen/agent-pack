# Git-source installs

AgentPack's primary distribution mechanism is **git**. Any AgentPack manifest committed to a public (or accessible-private) git repo at a stable ref is a valid install source — no registry required.

```bash
workgraph install github:owner/repo[@ref][#subpath] \
  --target claude-code --profile safe \
  --project ./my-project --yes
```

## Source syntax

| Form | Example | Notes |
|------|---------|-------|
| `github:owner/repo` | `github:jckeen/agent-pack` | Resolves the repo's default branch via GitHub API |
| `github:owner/repo@ref` | `github:jckeen/agent-pack@v0.5.0` | Tag, branch, or commit SHA |
| `github:owner/repo@ref#subpath` | `github:jckeen/agent-pack@master#examples/pr-quality` | AGENTPACK.yaml lives at `<subpath>/AGENTPACK.yaml` |
| `github.com/owner/repo[@ref][#subpath]` | `github.com/foo/bar@v1.0.0` | URL-paste form; same semantics |

The `@ref` accepts anything `raw.githubusercontent.com` accepts:

- A tag — `@v1.0.0`
- A branch — `@main` or `@release/v1`
- A commit SHA — `@a91c066` (any length git recognizes)

The `#subpath` is useful when one repo holds multiple AgentPacks under different directories (the AgentPack repo itself does this — `examples/pr-quality` is a pack).

A trailing `.git` is tolerated and stripped: `github:foo/bar.git@v1.0.0` works.

## Source-detection order

The CLI's `install [pack]` command resolves the `pack` argument in this order:

1. **Local path** — if the argument resolves to a directory on disk, treat it as a local-path install. Local always wins; the user can disambiguate by passing `github:` explicitly.
2. **Git source** — if the argument matches the git syntax above, fetch from `raw.githubusercontent.com`.
3. **Registry id** — if the argument matches `publisher/pack[@version]`, fetch from the configured registry (default: `https://registry.workgraph.dev`).

## What gets fetched

1. The CLI fetches `AGENTPACK.yaml` from `raw.githubusercontent.com/{owner}/{repo}/{ref}/{subpath}/AGENTPACK.yaml`.
2. The manifest is parsed; `atoms[].files[].path` enumerates every file the pack needs.
3. Each file is fetched from `raw.githubusercontent.com/{owner}/{repo}/{ref}/{subpath}/{path}`.
4. All files land in a temp directory.
5. The existing `planInstall` → `applyInstall` pipeline takes over: diff against project root, back up overwrites, atomically write, append to history.jsonl, write AGENTPACK.lock.

The lockfile records the resolved ref, the per-file sha256 of what was actually fetched, the install timestamp, and the install profile.

## What's intentionally not here yet

### Signature verification for git sources (v0.5.1)

`workgraph install <git-source> --require-sig` currently exits 2 with a clear deferral message:

```
✗ --require-sig with a git source is not supported in v0.5.
  Git-source signature verification (cosign-on-tag) arrives in v0.5.1.
  For signed-by-default today, publish to a registry and install via
  `workgraph install <publisher>/<pack>@<version> --require-sig`.
```

Phase 4 cosign keyless signs the **manifest** content via Sigstore Fulcio + Rekor at publish time. Extending the same to git-tag signatures (`git tag -s` + `sigstore-tag verify`) is on the v0.5.1 roadmap.

For signed installs today: publish to a registry and pass `--require-sig`. The registry serves the signature alongside the manifest.

### Non-GitHub git hosts

v0.5 supports `github:` and `github.com/` prefixes only. The parser is host-aware and can extend cleanly to `gitlab:`, `bitbucket:`, `sourcehut:`, and generic `git+https://...` forms when there's demand — open an issue if you have a concrete use case.

### Tarball downloads

The current fetcher hits `raw.githubusercontent.com` per file, which is fine for typical packs (10-20 files) and avoids any `tar` dependency. Tarball-based fetch (one HTTP request, one extraction) is on the table for repos with many atoms.

## Comparison vs. registry installs

| Concern | Git source | Registry |
|---------|------------|----------|
| Distribution | `raw.githubusercontent.com` | Registry REST API |
| Discovery | GitHub search, awesome-list, README links | Registry catalog + search index |
| Versioning | Tags, branches, SHAs | Semver via registry-issued versions |
| Signature | (v0.5.1: cosign-on-tag) | Sigstore Fulcio + Rekor (Phase 4) |
| Quarantine | Publisher rotates tag / archives repo | Registry sets `pack_versions.status='quarantined'` (admin UI) |
| Atomicity | Git ref is immutable | Two-phase init+finalize |
| Private packs | Repo visibility (private repo + access token) | Token-scoped read |
| Enterprise audit | git log + GitHub audit | Hash-chained `audit_events` |

For **public OSS distribution**, git is the leaner choice. For **private cross-org catalogs** or **enterprise self-host with audit**, the registry earns its keep.

## Examples

Install the AgentPack repo's bundled PR-Quality example pack from a specific tag:

```bash
workgraph install github:jckeen/agent-pack@v0.5.0#examples/pr-quality \
  --target claude-code --profile safe \
  --project ./my-project --yes
```

Install the same pack from the current `master` (moving target):

```bash
workgraph install github:jckeen/agent-pack@master#examples/pr-quality \
  --target codex --profile standard --project ./my-project --yes
```

Install from a private repo (requires a GitHub token in env that has read access; signature verification still deferred to v0.5.1):

```bash
GITHUB_TOKEN=ghp_... workgraph install github:my-org/private-pack@v1.0.0 \
  --target claude-code --profile full --project ./my-project --yes
```

(Private-repo support reads `GITHUB_TOKEN` from env when present; details in v0.5.1.)
