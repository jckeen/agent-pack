# `agentpack` CLI

The CLI lives in [`../packages/cli`](../packages/cli) and exposes the same engine as `@agentpack/core` and the registry. Read-only commands (`validate`, `inspect`, `plan`, `diff`, `verify`, `history`, `whoami`, `doctor`, `cache size`) never touch your project tree. Write commands (`init`, `pack export`, `pack plugin`, `install`, `uninstall`, `rollback`, `publish`, `login`, `tokens`, `cache prune|clear`) declare their write surface up front.

> AgentPack isn't on npm yet (planned for v0.3.0 promotion). Until then, build the CLI locally:
>
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
agentpack plan [path] [--target <target>] [--profile <profile>] [--only <ids>] [--json]
```

Resolves atoms for the profile, computes risk + permissions, runs the adapter to produce a file plan, and prints the pack id, target/profile/risk badge, selected atoms, permission summary (with secrets / network / shell), and the full file plan. No files are written. `--only` accepts a comma-separated list of atom IDs to filter further. `--json` emits the whole plan as a single JSON object for agents and scripts.

### `agentpack diff [pack] --target <t> --profile <p> --project <dir>`

Computes the same plan as `install`, but prints a unified diff between current project files and what the install would write. Read-only — exits without writing.

### `agentpack verify <packId> [--project <dir>] [--sig] [--strict] [--chain] [--expected-signer <san>]`

Computes per-file SHA-256 of every lockfile-tracked file under `--project`, reports `clean` or per-path `drift[]`/`missing[]`. Files installed via **merge** (shared `CLAUDE.md` / `AGENTS.md` / JSON configs — see [`install.md`](./install.md)) are checked at fragment level: only the pack's own marker span / JSON entries must be intact, so the user editing their own sections of a shared file is not drift. With `--sig`, also verifies the Sigstore signature on the manifest. With `--strict`, exits non-zero on unsigned packs. With `--expected-signer <san>`, the certificate identity must equal `<san>`; the signer is also accepted if it matches `install.allowedSigners` in `agentpack.policy.json`. Without any pin, a valid signature from ANY Sigstore identity passes and the CLI says so explicitly — unless policy `install.requireIdentity` is set, which refuses an unpinned signer (exit 4). With `--chain`, validates the hash-chain integrity of `.agentpack/history.jsonl`.

Exit codes follow the project taxonomy (see below).

### `agentpack history [--pack <id>] [--project <dir>] [--json]`

Lists `.agentpack/history.jsonl` entries (most recent first) — install_begin, install_commit, uninstall, rollback events. `--pack` filters by pack id; `--json` emits one JSON object per line for piping.

### `agentpack whoami`

Reads `~/.agentpack/credentials.json`, calls `/api/me` on the configured registry, prints the authenticated user + publisher memberships. Exits 1 when not logged in, so scripts can gate on it.

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

### `agentpack pack plugin [path]`

```
agentpack pack plugin [path] [--profile <profile>] [--out <dir>] [--only <ids>] [--no-strict] [--no-marketplace]
```

Compiles a pack into a **Claude Code plugin** directory — `.claude-plugin/plugin.json` (+ `marketplace.json` unless `--no-marketplace`) with `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, and `.mcp.json` at the plugin root. The directory is installable via the unified Directory or `/plugin marketplace add <repo>` then `/plugin install <name>@<name>-marketplace`, so one install reaches **Claude Code, Cowork, Desktop, and the web Directory** — not just the terminal.

It reuses the `claude-code` adapter and relocates its output into plugin layout. Because instruction/rule atoms have no ambient home outside Claude Code, their content is bundled into an on-invoke `<slug>-guidance` skill — available everywhere the plugin installs, but explicitly **not ambient** the way `CLAUDE.md` is in Code. Hooks are emitted, but fire **only in Claude Code** (inert on Cowork/web/Desktop). The command prints a **portability** breakdown of the bundled atoms (see `inspect`).

**Portability ceilings** (shown by `inspect` and `pack plugin`): `universal` (skills, MCP — reach every surface), `plugin` (commands, subagents — plugin-aware surfaces), `sdk` (workflows — Agent SDK/Managed Agents only), `terminal` (hooks, instructions, rules — Claude Code only). A pack's overall reach is bounded by its least-portable atom.

## Install commands (write to `--project`)

### `agentpack install <source>`

```
agentpack install <source> \
  --target <target> --profile <profile> \
  --project <dir> \
  [--yes] [--dry-run] [--force] [--json] [--allow-critical] \
  [--fail-on-unsupported] \
  [--require-sig] [--expected-signer <san>] [--registry <url>]
```

`<source>` can be:

- **A local path** (e.g. `./my-pack` or `examples/pr-quality`).
- **A git source** — `github:owner/repo[@ref][#subpath]` or `github.com/owner/repo[@ref][#subpath]` (see [`git-source.md`](./git-source.md)).
- **A registry identity** — `<publisher>/<pack>[@<version>]` (when the hosted registry is available; see [`remote-install.md`](./remote-install.md)).

The CLI runs the same WAL-protected pipeline regardless of source: plan → backup → write begin entry → write project files → write manifest → write commit entry. Shared files **merge** instead of conflicting: an existing user `CLAUDE.md`/`AGENTS.md` gets the pack's marker block appended (other packs' blocks and user content are preserved), and `.claude/settings.json` / `.mcp.json` / `.cursor/mcp.json` are deep-merged (the pack's hook entries and MCP servers are added; user entries are untouched). See [`install.md`](./install.md) for the full merge semantics.

Flags: `--yes` skips the interactive `[y/N]` prompt (required in non-TTY sessions — a missing `--yes` without a terminal exits 2 immediately instead of hanging); `--dry-run` previews without writing and exits 2 if conflicts exist; `--json` emits the plan/result as one JSON object (paths created/modified/unchanged, conflicts with reasons, merges, history entry id); `--force` allows overwriting genuinely conflicting files (after backup); `--allow-critical` is required to install a plan whose computed risk is `critical` — `--yes` alone never crosses that line; `--fail-on-unsupported` exits `2` instead of installing when any selected atom is dropped — whether because the target doesn't support it or because a security gate refused it (e.g. a shell-escape MCP command). By default such atoms are skipped, the install succeeds, and the dropped atoms are listed in the summary and in the `unsupportedAtoms` field of `--json`. With `--json`, an expected refusal (`critical_risk_refused`, `unsupported_atoms`) is emitted as a structured object on stdout rather than prose on stderr. `--require-sig` refuses to install unsigned packs (registry-resolved sources only — see exit code 5); `--expected-signer <san>` additionally pins the Sigstore identity (an untrusted signer exits 4), and `install.allowedSigners` / `install.requireIdentity` in `agentpack.policy.json` enforce the same pin org-wide; `--registry <url>` overrides the default registry endpoint (subject to `agentpack.policy.json` allowlist).

Installing the same pack for a **second target** into one project is refused (it would orphan the first target's files) — uninstall first or use separate project directories.

### `agentpack uninstall <packId> --project <dir> [--yes] [--force] [--force-restore]`

Reads the install manifest at `.agentpack/installed/<packId>.json` and removes the pack's footprint: plainly-created files are deleted; **merged** files get surgical removal — only the pack's marker span or JSON entries are taken out, the user's surrounding content stays. Whole-file overwrites are restored from backup. The conflict scan runs **before** any mutation: a refused uninstall touches zero files. Refuses without `--force`/`--force-restore` when the pack's content was user-edited after install.

### `agentpack rollback [historyEntryId] --project <dir> [--yes] [--to <id>] [--pack <id>] [--cascade]`

Restores the project to the state before the named history entry (or to a target entry via `--to`). Refuses to roll back a superseded install unless `--cascade` is passed to make undoing the later installs explicit. `--pack` limits the rollback to one pack.

**Re-installs.** When the entry being rolled back _re-installed_ a pack that an earlier (non-undone) install still owns, "the state before this entry" means the pack stays installed — a full uninstall would over-remove. So:

- An **idempotent re-install** (same version + profile) is undone as a no-op: the pack remains installed at its identical prior state, reported as `Still installed (idempotent re-install undone, no file changes)`.
- A **version/profile-changing re-install** is **refused** without `--cascade`, because local backups cannot reconstruct the prior version — re-install the version you want explicitly, or pass `--cascade` to remove the pack entirely.

Rolling back when the most recent install was already uninstalled reports _nothing to roll back_ (rather than a missing-manifest error).

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

| Code | Meaning                                                                                                                                  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                  |
| `1`  | runtime error (validation failure, fs error, etc.)                                                                                       |
| `2`  | bad invocation (unknown target/profile), drift (`verify`), dry-run conflicts, **or** `install --fail-on-unsupported` with a dropped atom |
| `3`  | history-chain integrity failure (`verify --chain`)                                                                                       |
| `4`  | signature invalid (`verify --sig`)                                                                                                       |
| `5`  | unsigned pack rejected (`--require-sig`)                                                                                                 |
| `6`  | policy violation (`agentpack.policy.json`) **or** critical-risk plan without `--allow-critical`                                          |
| `7`  | integrity error (registry-declared sha256 mismatched fetched bytes)                                                                      |
| `8`  | not found (registry returned 404, or a command run against an uninstalled pack — e.g. `verify`/`uninstall` with no install manifest)     |
| `9`  | conflict (`uninstall` blocked by user edits; registry `version_exists` on publish)                                                       |

These codes are honored even when a command throws past its own explicit `process.exit`: the CLI's top-level handler maps typed domain errors to their pinned code (`InstallManifestNotFoundError`/`VersionNotFoundError`/`BlobNotFoundError` → 8, `IntegrityError` → 7, `UninstallConflictError` → 9) rather than collapsing everything to 1.

Additional conventions: a **declined** confirmation prompt ("Aborted.") exits `1`; a confirmation required in a **non-TTY** session without `--yes` exits `2`; `install --dry-run` exits `2` when the plan has conflicts. Set `AGENTPACK_DEBUG=1` to print stack traces with errors.

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
