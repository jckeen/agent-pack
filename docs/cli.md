# `agentpack` CLI

The CLI lives in [`../packages/cli`](../packages/cli) and exposes the same engine as `@agentpack/core` and the registry. Read-only commands (`validate`, `inspect`, `plan`, `diff`, `verify`, `history`, `whoami`, `doctor`, `cache size`) never touch your project tree. Write commands (`init`, `pack export`, `install`, `uninstall`, `rollback`, `publish`, `login`, `tokens`, `cache prune|clear`) declare their write surface up front.

> AgentPack isn't on npm yet (planned for v0.3.0 promotion). Until then, build the CLI locally:
> ```bash
> git clone https://github.com/jckeen/agent-pack && cd agent-pack
> pnpm install && pnpm build
> alias agentpack="node $(pwd)/packages/cli/dist/index.js"
> ```

## Read-only / inspect commands

### `agentpack init`

```
agentpack init [--force]
```

Scaffolds a starter `AGENTPACK.yaml`, a minimal instruction atom, and an example skill atom in the current directory. `--force` overwrites existing files.

### `agentpack validate [path]`

```
agentpack validate [path]
```

Loads `AGENTPACK.yaml` (or the file/directory at `[path]`), runs the schema + semantic validators, and prints errors/warnings. Exits non-zero on failure.

### `agentpack inspect [path]`

```
agentpack inspect [path] [--profile <name>]
```

Prints metadata (name, id, version, publisher, tags), compatibility matrix, profiles, atoms, and a permission/risk preview for `--profile` (default `safe`).

### `agentpack plan [path]`

```
agentpack plan [path] [--target <target>] [--profile <profile>] [--only <ids>]
```

Resolves atoms for the profile, computes risk + permissions, runs the adapter to produce a file plan, and prints the pack id, target/profile/risk badge, selected atoms, permission summary (with secrets / network / shell), and the full file plan. No files are written. `--only` accepts a comma-separated list of atom IDs to filter further.

### `agentpack diff [pack] --target <t> --profile <p> --project <dir>`

Computes the same plan as `install`, but prints a unified diff between current project files and what the install would write. Read-only — exits without writing.

### `agentpack verify <packId> [--project <dir>] [--sig] [--strict] [--chain]`

Computes per-file SHA-256 of every lockfile-tracked file under `--project`, reports `clean` or per-path `drift[]`/`missing[]`. With `--sig`, also verifies the Sigstore signature on the manifest. With `--strict`, exits non-zero on unsigned packs. With `--chain`, validates the hash-chain integrity of `.agentpack/history.jsonl`.

Exit codes follow the project taxonomy (see below).

### `agentpack history [--pack <id>] [--project <dir>] [--json]`

Lists `.agentpack/history.jsonl` entries (most recent first) — install_begin, install_commit, uninstall, rollback events. `--pack` filters by pack id; `--json` emits one JSON object per line for piping.

### `agentpack whoami`

Reads `~/.agentpack/credentials.json`, calls `/api/me` on the configured registry, prints the authenticated user + publisher memberships. No-op if not logged in.

### `agentpack doctor`

Prints environment checks: Node ≥ 22, pnpm presence, npm presence, git presence, and whether an `AGENTPACK.yaml` exists in the current directory. Use it as a first stop when something looks wrong.

### `agentpack cache size`

Prints the total bytes + entry count of the content-addressed blob cache at `~/.agentpack/cache/blobs/`.

## Build / export commands (write to `--out` only)

### `agentpack pack export [path]`

```
agentpack pack export [path] [--target <target>] [--profile <profile>] [--out <dir>] [--only <ids>] [--no-strict]
```

The same engine as `plan`, but writes the planned files to `--out`. `--no-strict` writes even when the manifest has validation errors (useful for partial-export debugging). Refuses to write outside `--out` (path-containment check in the exporter). Output is deterministic — two runs produce byte-identical files.

## Install commands (write to `--project`)

### `agentpack install <source>`

```
agentpack install <source> \
  --target <target> --profile <profile> \
  --project <dir> \
  [--yes] [--dry-run] [--force] [--require-sig] [--registry <url>]
```

`<source>` can be:

- **A local path** (e.g. `./my-pack` or `examples/pr-quality`).
- **A git source** — `github:owner/repo[@ref][#subpath]` or `github.com/owner/repo[@ref][#subpath]` (see [`git-source.md`](./git-source.md)).
- **A registry identity** — `<publisher>/<pack>[@<version>]` (when the hosted registry is available; see [`remote-install.md`](./remote-install.md)).

The CLI runs the same WAL-protected pipeline regardless of source: plan → backup any existing AgentPack-marked content → write begin entry → write project files → write manifest → write commit entry. With `--yes` it skips the interactive `[y/N]` prompt; `--dry-run` exits 0 without writing; `--force` allows overwriting non-AgentPack-marked files (after backup); `--require-sig` refuses to install unsigned packs (registry-resolved sources only — see exit code 5); `--registry <url>` overrides the default registry endpoint (subject to `agentpack.policy.json` allowlist).

### `agentpack uninstall <packId> --project <dir> [--yes] [--force-restore]`

Reads the install manifest at `.agentpack/installed/<packId>.json`, restores backups, deletes created files, removes the manifest, appends an `uninstall` history entry. Refuses without `--force-restore` if a restored file would overwrite user-edited content.

### `agentpack rollback [historyEntryId] --project <dir> [--yes] [--to <id>]`

Restores the project to the state before the named history entry (or to a target entry via `--to`). Refuses to roll back a superseded install unless `--to` is specified to make the cascade explicit.

## Registry / publish commands (require login)

### `agentpack login [--registry <url>]`

Opens a browser to `<registry>/cli/auth`, runs the device-code flow, writes `~/.agentpack/credentials.json` with `0o600` perms.

### `agentpack publish [path] [--sign] [--no-sign] [--registry <url>]`

Reads the manifest at `[path]` (default `AGENTPACK.yaml` in CWD), computes per-file sha256, POSTs `/api/publish/init`, uploads each file to the presigned R2 URL, POSTs `/api/publish/<id>/finalize`. With `--sign` (default when OIDC token available; `SIGSTORE_ID_TOKEN` env or GitHub Actions ambient): signs the manifest checksum via Sigstore Fulcio + Rekor before finalize.

### `agentpack tokens list | create | revoke`

`list` prints active tokens (masked); `create --name <n> --scopes <list>` mints a new API token; `revoke <id>` sets `revoked_at`.

## Cache commands

### `agentpack cache prune --max-age <duration>`

Removes blobs older than `<duration>` (e.g. `30d`, `12h`) from `~/.agentpack/cache/blobs/`. Never writes outside the cache root.

### `agentpack cache clear`

Empties the blob store.

## Target platforms

`claude-code`, `codex`, `cursor`, `chatgpt`, `generic`.

## Profiles

`safe`, `standard`, `full`, `enterprise` (convention — pack authors are free to define more).

## Exit codes

| Code | Meaning |
|------|---------|
| `0`  | success |
| `1`  | runtime error (validation failure, fs error, etc.) |
| `2`  | bad invocation (unknown target/profile) **or** drift detected by `verify` |
| `3`  | history-chain integrity failure (`verify --chain`) |
| `4`  | signature invalid (`verify --sig`) |
| `5`  | unsigned pack rejected (`--require-sig`) |
| `6`  | policy violation (`agentpack.policy.json` rejected install) |
| `7`  | integrity error (registry-declared sha256 mismatched fetched bytes) |
| `8`  | not found (registry returned 404 for the requested pack/version) |

## Examples

```bash
# Local example pack — read-only inspect/plan
agentpack validate examples/pr-quality
agentpack inspect examples/pr-quality --profile standard
agentpack plan examples/pr-quality --target claude-code --profile safe
agentpack plan examples/pr-quality --target claude-code --profile full  # warns

# Install from git source — no registry required
agentpack install github:jckeen/agent-pack@master#examples/pr-quality \
  --target claude-code --profile safe --project /tmp/my-claude-project --yes

# Verify + history + uninstall round-trip
agentpack verify agentpack.pr-quality --project /tmp/my-claude-project
agentpack history --project /tmp/my-claude-project
agentpack uninstall agentpack.pr-quality --project /tmp/my-claude-project --yes

# Export all five targets to dist/
for t in claude-code codex cursor chatgpt generic; do
  agentpack pack export examples/pr-quality \
    --target "$t" --profile safe \
    --out "dist/$t"
done
```
