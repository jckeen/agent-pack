# `agentpack` CLI

The CLI lives in [`../packages/cli`](../packages/cli) and exposes the same engine as `@agentpack/core` and the registry. Read-only commands (`validate`, `inspect`, `plan`, `diff`, `verify`, `update --check`, `history`, `whoami`, `doctor`, `cache size`) never touch your project tree. Write commands (`init`, `pack export`, `pack plugin`, `install`, `uninstall`, `rollback`, `publish`, `login`, `tokens`, `cache prune|clear`) declare their write surface up front.

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

### `agentpack verify <packId> | --all [--project <dir>] [--quiet] [--sig] [--sig-if-present] [--chain] [--expected-signer <san>]`

Computes per-file SHA-256 of every lockfile-tracked file under `--project`, reports `clean` or per-path `drift[]`/`missing[]`. Files installed via **merge** (shared `CLAUDE.md` / `AGENTS.md` / JSON configs — see [`install.md`](./install.md)) are checked at fragment level: only the pack's own marker span / JSON entries must be intact, so the user editing their own sections of a shared file is not drift. With `--sig`, also verifies the Sigstore signature on the manifest and **fails (exit 5) if the lockfile is unsigned** — signing is enforced by default. Pass `--sig-if-present` for the lenient variant that passes on an unsigned lockfile (the old `--sig` behavior); `--strict` is a deprecated alias for `--sig`. With `--expected-signer <san>`, the certificate identity must equal `<san>`; the signer is also accepted if it matches `install.allowedSigners` in `agentpack.policy.json`. Without any pin, a valid signature from ANY Sigstore identity passes and the CLI says so explicitly — unless policy `install.requireIdentity` is set, which refuses an unpinned signer (exit 4). With `--chain`, validates the hash-chain integrity of `.agentpack/history.jsonl`.

With `--all` (instead of a packId), verifies **every** pack recorded under `.agentpack/installed/` and exits with the most severe result across packs (chain break `3` > drift `2`); the signature flags still require a single packId (the v2 lockfile records a signature per pack entry, but aggregate `--all --sig` exit semantics are unspecified). `--quiet` prints nothing and communicates through the exit code only — `verify --all --quiet` is the shape the sync SessionStart notifier (phase S4) calls.

Exit codes follow the project taxonomy (see below).

### `agentpack update [packId] [--check] [--to <ref>] [--yes] [--allow-exec] [--theirs <glob>] [--keep-local <glob>] [--dry-run] [--project <dir>] [--scope user] [--quiet] [--json]`

The sync primitive ([`sync-design.md`](./sync-design.md); `--check` shipped in S1 [#110](https://github.com/jckeen/agent-pack/issues/110), the apply path in S2 [#111](https://github.com/jckeen/agent-pack/issues/111), user scope in S3 [#112](https://github.com/jckeen/agent-pack/issues/112) — workflow in [`sync.md`](./sync.md)).

**`--check` (read-only).** For each install manifest (or just `packId`'s), re-resolve the recorded `source` provenance block:

- **git sources** on the `branch` channel: re-resolve the recorded ref via the GitHub API and compare commit SHAs; a moved branch prints `old → new` and counts as an available update. `pinned` (40-hex ref) and `tag` channels never move implicitly.
- **registry sources** on the `latest` channel: compare the installed version against the newest published version. Exact-version installs are `pinned`.
- installs with **no `source` block** (local paths, pre-S1 lockfiles) are reported and skipped.

Check exit codes: `0` = everything current (or nothing checkable), `10` = at least one update available, `1` = a check failed. `--quiet` is exit-code-only; `--json` emits `{ updatesAvailable, packs[] }`. The check never touches the project tree.

**Apply (bare `update`).** Re-fetches the source, then runs a per-file **three-way reconcile** — BASE (what the pack wrote at install, from the install manifest) vs LOCAL (on disk) vs NEW (the fetched version):

- LOCAL == BASE, NEW moved → **applied** (this covers markerless pack-owned files like skills: ownership is the manifest hash, not a marker).
- LOCAL edited, NEW unchanged → **retained** — your edit is kept and reported as retained drift.
- both changed → **conflict**: the update refuses (exit `2`) listing the paths; resolve per-glob with `--theirs` (take the pack's version — your edit is backed up first, restorable) or `--keep-local` (keep your edit, skip that path). Marker-merged files (`CLAUDE.md`/`AGENTS.md`) compare the pack's _fragment_, so your content around the span never conflicts.
- files whose atoms were **deleted upstream** are surgically removed (fragment unmerge / owned-file delete / pre-install backup restore); a user-edited removal target is skipped and reported, never deleted.

Every install-grade gate runs on the delta: policy (exit `6`), **exec re-consent** — an unsigned update that adds or touches executable content (hook/`mcp_server` atoms, hook scripts, MCP configs, bang-bash command bodies) refuses without `--allow-exec`, even with `--yes` — and the policy `update` section's channel ceiling / `requireReconsent` / `maxRiskEscalation` (see [`policy.md`](./policy.md)). The channel is **re-derived live at update time** — a tampered manifest cannot turn a pinned install into a tracking one. `pinned`/`tag` installs move only via `--to <ref>` (which also re-pins `requestedRef`). Applies use the same WAL discipline as install (`update_begin`/`update_commit` + backups), so a crash mid-update is rolled back or forward by the automatic recovery sweep. `--dry-run` prints the full reconcile report and writes nothing. Registry-sourced installs: the apply path is deferred until the registry live-smoke lands — `update` prints the exact signed `install` command to run instead; `--check` fully works.

Credential hygiene: the recorded `source` block is attacker-influenced input when a repo ships committed `.agentpack/installed/` state, so the check path treats it accordingly — a registry URL from a manifest must be https (plaintext only to loopback), only a token you explicitly stored via `login` for **exactly** that URL is attached (never the ambient `AGENTPACK_TOKEN`), and registry requests refuse redirects with the bearer attached.

**`--scope user` (sync S3).** Targets the `~/.claude` install instead of a project: state is read from `~/.claude/.agentpack/`, and each pack is re-planned with the scope its install manifest recorded, so user-layout paths reconcile correctly. Mutually exclusive with `--project`. All gates (exec re-consent, policy, conflicts, `--dry-run` zero-writes) behave identically.

Env knobs (test harnesses / enterprise proxies): `AGENTPACK_GITHUB_API_URL` / `AGENTPACK_GITHUB_RAW_URL` repoint the GitHub API and raw-content hosts (used by the sync e2e gate's local mock server). With an override active, `GITHUB_TOKEN`/`GH_TOKEN` is **withheld** from the override host unless `AGENTPACK_GITHUB_TOKEN_ALLOW_OVERRIDE=1` is also set — token egress to a non-GitHub host is a conscious, greppable opt-in.

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

Compiles a pack into a **Claude Code plugin** directory — `.claude-plugin/plugin.json` (+ `marketplace.json` unless `--no-marketplace`) with `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, and `.mcp.json` at the plugin root. The plugin format **is** the Claude Cowork install format: the directory is installable via the unified Directory or `/plugin marketplace add <repo>` then `/plugin install <name>@<name>-marketplace`, so one install reaches **Claude Code, Cowork, Desktop, and the web Directory** — not just the terminal.

It reuses the `claude-code` adapter and relocates its output into plugin layout. Because instruction/rule atoms have no ambient home outside Claude Code, their content is bundled into an on-invoke `<slug>-guidance` skill — available everywhere the plugin installs, but explicitly **not ambient** the way `CLAUDE.md` is in Code. Hooks ride the plugin too: [Hooks are a Cowork-supported plugin component](https://claude.com/docs/cowork/3p/extensions), so they reach Cowork (not Code-only). The command prints a **portability** breakdown of the bundled atoms (see `inspect`).

**Portability ceilings** (shown by `inspect` and `pack plugin`): `universal` (skills, MCP — reach every surface), `plugin` (commands, subagents, hooks — plugin-aware surfaces incl. Cowork), `sdk` (workflows — Agent SDK/Managed Agents only), `terminal` (instructions, rules — Claude Code only, no `CLAUDE.md` loader elsewhere). A pack's overall reach is bounded by its least-portable atom.

#### Org-governance: distributing a governed plugin org-wide

The plugin target is the **admin-distribution** path for the compiler-plus-governance model. A pack carries risk scoring, a permission summary, and install profiles; compiling it with a chosen profile (e.g. `--profile enterprise`) produces a plugin whose contents are reproducible from one source pack and auditable before rollout.

To make it required org-wide, an admin distributes the compiled directory through Cowork **org-plugins**: place it in the system-wide `org-plugins/` location on each device (e.g. macOS `~/Library/Application Support/Claude/org-plugins/`). Org-plugins are **auto-installed, take precedence over user plugins, and support per-tool policy locks** — so a governed pack becomes a locked, mandatory plugin across the org. AgentPack's role is upstream: it makes the artifact you drop into `org-plugins/` deterministic and inspectable (`agentpack inspect`, `agentpack plan`) rather than hand-assembled.

### `agentpack pack mcpb`

```
agentpack pack mcpb [path] [--profile <profile>] [--out <dir>] [--only <ids>] [--no-strict]
```

Compiles a pack's **stdio `mcp_server` atom** into a `.mcpb` ([MCP Bundle](https://blog.modelcontextprotocol.io/posts/2025-11-20-adopting-mcpb/)) — a ZIP with a root `manifest.json` (spec `manifest_version: "0.3"`) for **one-click local MCP install** on Claude Cowork and Desktop. This is the portable path for _local_ stdio servers there; the adapters' `.mcp.json`/connector output covers project-scoped and remote (http/sse) servers.

The same gates as `.mcp.json` apply: a server must be declared in `permissions.mcp.servers`, and shell-escape command shapes are refused. Required secrets (atom `env` entries marked `required`) become `user_config` fields wired into the manifest's `mcp_config.env` via `${user_config.KEY}` substitution — credentials are prompted at install time, never baked into the bundle. An `.mcpb` manifest describes a single server; if a pack has several eligible servers the first is bundled and the rest are reported. Target variants ([#133](https://github.com/jckeen/agent-pack/issues/133)) are **not** resolved here — `.mcpb` bundling reads only the atom's manifest fields, and the command warns when a bundled server declares variants.

### `agentpack pack chat`

```
agentpack pack chat [path] [--profile <profile>] [--out <dir>] [--only <ids>] [--no-strict]
```

Compiles a pack into **claude.ai (Claude Chat)** install artifacts written to `--out` (default `dist-chat`): uploadable skill ZIPs (native skills plus on-invoke bridges for `instruction`/`rule`/`command` atoms), a `connectors.json` recipe for remote MCP servers, a `project-instructions.md`, and an install `README.md`. Chat has no bundle format, so this fans the pack into copy-paste install steps. The command reports native vs on-invoke skill counts and warns that on-invoke skills apply **only when invoked** — there is no ambient instruction loader in Chat — and lists any atoms not portable to Chat. Target variants ([#133](https://github.com/jckeen/agent-pack/issues/133)) are **not** resolved by this exporter: an atom with a default `path`/`body` compiles that default, while a variant-only atom degrades to its description (skills) or is skipped (`connectors.json`) with an explicit warning naming the reason.

### `agentpack import <path>`

```
agentpack import <path> --id <publisher.slug> \
  [--from claude|claude-code|codex|chatgpt-gpt] [--out <dir>] [--name <name>]
agentpack import <path> --from claude-code --into <pack-dir> [--diff]
```

Compiles an existing setup into an AgentPack written to `--out` (default `agentpack-imported`). `--id <publisher.slug>` is **required** (e.g. `acme.team-defaults`). Sources via `--from`:

- **`claude`** (default) — reads a single `CLAUDE.md` / `AGENTS.md` file. Pass `-` as `<path>` to read from stdin.
- **`claude-code`** — reads a whole Claude Code config **directory** (`~/.claude`, or a project's `.claude/` + root `CLAUDE.md`): `CLAUDE.md` → instruction/rule atoms, `skills/` → skill atoms, `agents/` → subagent atoms (verbatim `.md`, preserving `tools`/`model`), `commands/` → command atoms, and `settings.json` `hooks` / `mcpServers` → hook / mcp_server atoms. **Hook scripts travel:** when a hook command points at a script file (under the imported tree or `~/.claude`), its body is bundled into the pack and the command rewritten to the portable `${CLAUDE_PROJECT_DIR}/.claude/hooks/<name>` form, so the hook actually runs after install (each bundled script is noted — its full contents ship). Reads **only** those surfaces by name — the credential store (`.credentials.json`) and runtime caches (`plugins/`, `projects/`, etc.) are never opened, and MCP `env` surfaces secret **key names** only (never values).
- **`codex`** — reads a Codex setup directory (shared `SKILL.md` / MCP / hooks / subagents / `AGENTS.md`); near-lossless and round-trips back through the `codex` adapter.
- **`chatgpt-gpt`** — reads a human-assembled ChatGPT-GPT bundle directory (`gpt.json` + optional `openapi.yaml` + `knowledge/`). The OpenAPI→MCP transpiler scaffolds tools (operationId→tool, auth→secrets/scopes); the emitted MCP servers are **scaffolding**, not runnable handlers, and the command prints the human-judgment steps required before the pack is usable.

Prints the imported atom count + per-type summary and any warnings, then suggests `agentpack validate <out>` (and `agentpack pack chat <out>` for the `chatgpt-gpt` path). Bad `--from` or a missing/malformed `--id` is a usage error (exit 2).

**`--into <pack-dir>` (sync S3, [#112](https://github.com/jckeen/agent-pack/issues/112)) — fold live edits back into an existing pack.** When you edited the live config directly instead of the pack repo, `--into` re-runs the importer and updates the pack **in place**: atom bodies, `permissions`, and `security` are regenerated from the live config; the pack author's packaging — `metadata` (id, name, version, description), `profiles`, `exports`, `adapters` — is preserved verbatim; files under `atoms/` whose live counterpart disappeared are removed. Another runtime's atom `variants` ([#133](https://github.com/jckeen/agent-pack/issues/133)) also survive the fold — variants and their files are carried over, except the variant for the fold's own source target, which the fresh content supersedes. The pack id comes from `<pack-dir>/AGENTPACK.yaml`, so `--id`/`--out` conflict with `--into` (usage error). `--diff` is a **zero-write preview**: it prints per-file adds/changes/removals with unified diffs and exits `0` when the pack is in sync, `2` when it isn't. Deliberately not automatic — you review with `git diff` and commit; the commit is the consent point for content that propagates to every machine (see [`sync.md`](./sync.md)).

## Install commands (write to `--project`)

### `agentpack install <source>`

```
agentpack install <source> \
  --target <target> --profile <profile> \
  --project <dir> | --scope user \
  [--yes] [--dry-run] [--force] [--json] [--allow-critical] [--allow-exec] \
  [--allow-partial-target] [--fail-on-unsupported] \
  [--require-sig] [--expected-signer <san>] [--registry <url>]
```

`<source>` can be:

- **A local path** (e.g. `./my-pack` or `examples/pr-quality`).
- **A git source** — `github:owner/repo[@ref][#subpath]` or `github.com/owner/repo[@ref][#subpath]` (see [`git-source.md`](./git-source.md)).
- **A registry identity** — `<publisher>/<pack>[@<version>]` (when the hosted registry is available; see [`remote-install.md`](./remote-install.md)).

A `--project` directory that doesn't exist yet is **created as part of the consented write plan** ([#145](https://github.com/jckeen/agent-pack/issues/145)): the plan announces the creation, it happens only under `--yes` or after you confirm, and `--dry-run` never creates it (zero-mutation contract).

The CLI runs the same WAL-protected pipeline regardless of source: plan → backup → write begin entry → write project files → write manifest → write commit entry. Shared files **merge** instead of conflicting: an existing user `CLAUDE.md`/`AGENTS.md` gets the pack's marker block appended (other packs' blocks and user content are preserved), and `.claude/settings.json` / `.mcp.json` / `.cursor/mcp.json` are deep-merged (the pack's hook entries and MCP servers are added; user entries are untouched). See [`install.md`](./install.md) for the full merge semantics.

Flags: `--yes` skips the interactive `[y/N]` prompt (required in non-TTY sessions — a missing `--yes` without a terminal exits 2 immediately instead of hanging); `--dry-run` previews without writing and exits 2 if conflicts exist; `--json` emits the plan/result as one JSON object (paths created/modified/unchanged, conflicts with reasons, merges, history entry id); `--force` allows overwriting genuinely conflicting files (after backup) — a forced **JSON collision** (`.claude/settings.json`, `.mcp.json`, …) writes the deep-merge with the pack winning only the collided keys, never the bare fragment (your other entries survive), and forced conflict files pass the same exec consent scan as any other write (a bang-bash body behind a conflict still requires `--allow-exec`); `--allow-critical` is required to install a plan whose computed risk is `critical` — `--yes` alone never crosses that line; `--allow-exec` is required to install an **unverified** pack that ships executable content — `hook` / `mcp_server` atoms, or a `command` / `subagent` whose body embeds a Claude Code bang-bash directive (`` !`…` ``) that runs shell on invocation (a plain prompt command is not gated) — all of which run author-supplied code on your machine; like `--allow-critical`, `--yes` alone never crosses it, and a pack whose signature is verified via `--require-sig` is exempt (provenance is established); `--fail-on-unsupported` exits `2` instead of installing when any selected atom is dropped — whether because the target doesn't support it or because a security gate refused it (e.g. a shell-escape MCP command). By default such atoms are skipped, the install succeeds, and the dropped atoms are listed in the summary and in the `unsupportedAtoms` field of `--json`. `--allow-partial-target` acknowledges installing to a target the pack's **authored** compatibility declares `partial` or `experimental` — without it the install refuses (exit `6`), even with `--yes`; a target the manifest declares `unsupported` refuses outright at plan time (exit `2`, nothing written, no override flag), and a target the manifest doesn't declare is never gated. The plan reports the authored claim and the compiler-**observed** fidelity (derived from adapter warnings + dropped atoms — dropped atoms always downgrade the observation to `partial`) as separate fields, both in the summary and as `authoredCompatibility` / `observedFidelity` in `--json` ([#134](https://github.com/jckeen/agent-pack/issues/134)). With `--json`, an expected refusal (`critical_risk_refused`, `exec_atoms_refused`, `partial_target_refused`, `unsupported_atoms`) is emitted as a structured object on stdout rather than prose on stderr. `--require-sig` refuses to install unsigned packs (registry-resolved sources only — see exit code 5); `--expected-signer <san>` additionally pins the Sigstore identity (an untrusted signer exits 4), and `install.allowedSigners` / `install.requireIdentity` in `agentpack.policy.json` enforce the same pin org-wide; `--registry <url>` overrides the default registry endpoint (subject to `agentpack.policy.json` allowlist).

**`--scope user` (sync S3, [#112](https://github.com/jckeen/agent-pack/issues/112)).** Installs into `~/.claude` instead of a project (claude-code target only; mutually exclusive with `--project`). The adapter's project-layout paths are remapped to their user-layout equivalents — `CLAUDE.md` → `~/.claude/CLAUDE.md`, `.claude/skills/…` → `~/.claude/skills/…`, `.claude/settings.json` → `~/.claude/settings.json` (deep-merged with your existing settings), hook commands rewritten from `$CLAUDE_PROJECT_DIR/.claude/hooks/…` to `$HOME/.claude/hooks/…` — and install state lands at `~/.claude/.agentpack/` (never inside a project). Honest ceiling: `.mcp.json` is written under `~/.claude` for reference, but Claude Code reads **user-scope** MCP servers from `~/.claude.json`, which AgentPack never edits — register those yourself. Every gate behaves identically (`--allow-exec`, `--allow-critical`, conflicts, backups); a `--dry-run` performs **zero writes** under `$HOME` — it won't even create a missing `~/.claude`. Verify with `agentpack verify --all --project ~/.claude`; update with `agentpack update --scope user`. Full workflow: [`sync.md`](./sync.md).

Installing the same pack for a **second target** into one project is refused (it would orphan the first target's files) — uninstall first or use separate project directories.

### `agentpack uninstall <packId> --project <dir> | --scope user [--yes] [--force] [--force-restore]`

Reads the install manifest at `.agentpack/installed/<packId>.json` and removes the pack's footprint: plainly-created files are deleted; **merged** files get surgical removal — only the pack's marker span or JSON entries are taken out, the user's surrounding content stays. Whole-file overwrites are restored from backup. The conflict scan runs **before** any mutation: a refused uninstall touches zero files. Refuses without `--force`/`--force-restore` when the pack's content was user-edited after install.

**`--scope user` ([#146](https://github.com/jckeen/agent-pack/issues/146)).** The exit door for `install --scope user`: targets the `~/.claude` install with the same project→`~/.claude` mapping install and update use (state read from `~/.claude/.agentpack/`). Mutually exclusive with `--project`. Audit artifacts (`~/.claude/.agentpack/` history/backups and `~/.claude/AGENTPACK.lock`) are deliberately retained, as in project scope.

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

There is no dedicated Antigravity target: Google Antigravity consumes the `generic` target's `AGENTS.md` (it auto-loads a workspace's `AGENTS.md` and `GEMINI.md` — verified against agy 1.1.0) and its skills use the same Agent Skills `SKILL.md` format.

## Profiles

`safe`, `standard`, `full`, `enterprise` (convention — pack authors are free to define more).

## Exit codes

| Code | Meaning                                                                                                                                                                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                                                                                                                    |
| `1`  | runtime error (validation failure, fs error, etc.)                                                                                                                                                                                                                                                                         |
| `2`  | bad invocation (unknown target/profile, or a target the pack declares `unsupported`), drift (`verify`), dry-run conflicts, **or** `install --fail-on-unsupported` with a dropped atom                                                                                                                                      |
| `3`  | history-chain integrity failure (`verify --chain`)                                                                                                                                                                                                                                                                         |
| `4`  | signature invalid (`verify --sig`)                                                                                                                                                                                                                                                                                         |
| `5`  | unsigned pack rejected (`--require-sig`)                                                                                                                                                                                                                                                                                   |
| `6`  | policy violation (`agentpack.policy.json`), critical-risk plan without `--allow-critical`, unverified plan shipping executable content (exec atoms, or a `command`/`subagent` body with a bang-bash directive) without `--allow-exec`, **or** an authored `partial`/`experimental` target without `--allow-partial-target` |
| `7`  | integrity error (registry-declared sha256 mismatched fetched bytes)                                                                                                                                                                                                                                                        |
| `8`  | not found (registry returned 404, or a command run against an uninstalled pack — e.g. `verify`/`uninstall` with no install manifest)                                                                                                                                                                                       |
| `9`  | conflict (`uninstall` blocked by user edits; registry `version_exists` on publish)                                                                                                                                                                                                                                         |
| `10` | update available (`update --check` — success-shaped: `0` = current, `10` = the recorded source has moved)                                                                                                                                                                                                                  |

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
