# Sync — your agent config on every machine

How to carry one person's agent configuration across machines and into
cloud/web sessions with git as the transport — no daemon, no required SaaS
account, and no silent updates of executable content. This is the workflow
guide; the design and its invariants live in
[`sync-design.md`](./sync-design.md), the flag reference in
[`cli.md`](./cli.md).

**The model:** your pack repo is the source of truth; your live config
(`~/.claude`, a project's `.claude/`) is a build artifact. AgentPack is the
compiler in both directions — `install`/`update` compile the pack onto a
machine, `import --into` folds live edits back into the pack — and git does
the actual syncing.

## The personal-config loop (`~/.claude` everywhere)

**1. Seed once** — compile your live config into a pack and push it:

```bash
agentpack import ~/.claude --from claude-code --id me.dotfiles --out ~/dev/my-agentpack
cd ~/dev/my-agentpack && git init && git add -A && git commit -m "seed" && git push
```

The importer carries skills, agents, commands, hooks (script bodies bundled so
they run on other machines), and MCP servers. Secrets never travel:
`.credentials.json` is never opened and MCP `env` surfaces key **names** only.

A newly imported manifest marks a lossless source runtime `supported`. Other
targets start as `partial`: AgentPack can compile the atoms, but transport does
not prove that platform-specific tool names, lifecycle events, or delegation
semantics are equivalent. Lossy ChatGPT imports remain `experimental`. Promote
a target only after reviewing and exercising its exported behavior.

**2. Install everywhere** — on each machine:

```bash
agentpack install github:me/my-agentpack --target claude-code --scope user --yes --allow-exec
```

`--scope user` roots the install at `~/.claude` with user-layout paths
(`~/.claude/CLAUDE.md`, `~/.claude/skills/…`, `~/.claude/settings.json`
deep-merged with your existing settings, hook scripts at `~/.claude/hooks/`
invoked via `$HOME/.claude/…`). Install state lives at `~/.claude/.agentpack/`
— no project is touched. `--allow-exec` is required because the pack ships
hooks and the git source is unsigned — that consent is per-machine and
re-required on every exec-bearing update, by design.

**3. Evolve from the pack side** — edit atoms in the pack repo, commit, push.
Every other machine pulls the change through the gated update path:

```bash
agentpack update --scope user --check   # exit 10 = something moved (read-only)
agentpack update --scope user --yes     # three-way reconcile, backups, gates
```

Updates never clobber a local edit silently: upstream-unchanged local edits
are retained, both-changed files refuse with exit 2 (`--theirs`/`--keep-local`
resolve per-glob, always backed up), and a delta that adds or touches
executable content (hook scripts, `settings.json` hooks, MCP configs) refuses
without a fresh `--allow-exec` — even with `--yes`. `--dry-run` previews the
full reconcile with **zero writes** under `$HOME`.

**4. Fold back live edits** — when you edited `~/.claude` directly instead of
the pack repo:

```bash
agentpack import ~/.claude --from claude-code --into ~/dev/my-agentpack --diff  # preview (exit 2 = out of sync)
agentpack import ~/.claude --from claude-code --into ~/dev/my-agentpack        # apply in place
cd ~/dev/my-agentpack && git diff                                              # review, then commit + push
```

`--into` regenerates atom bodies, `permissions`, and `security` from the live
config while preserving your packaging (`metadata`, `profiles`, `exports`,
`adapters`); stale `atoms/` files are removed. It is deliberately **not**
automatic — your commit is the consent point for content that propagates to
every machine.

**Drift check:** `agentpack verify --all --project ~/.claude` reports any
tracked file that drifted from the lockfile (exit 2). A deliberate improvement
gets folded back (step 4); an accident gets restored by re-running `update` or
`install`.

## Project scope: teammates and CI

For a project pack, install with compiled output committed (the default
project scope). The repo then carries `CLAUDE.md`, `.claude/…`, `.mcp.json`,
`AGENTPACK.lock`, and `agentpack.policy.json` to every clone — teammate, CI,
cloud sandbox — and any machine with the CLI can run `verify` or
`update --check` against the committed provenance. `agentpack update` on one
machine + push is how everyone else (and every web session) gets the new
version on their next pull.

## Web sessions: three lanes, honest ceilings

1. **The project repo (free, already works).** Claude Code on the web and
   cloud sandboxes clone the project, so committed project-scope output
   travels with zero new machinery. This is the recommended lane for anything
   project-shaped.
2. **Plugins (account-level).** `agentpack pack plugin` compiles a pack to a
   Claude Code plugin; an account-level plugin follows _you_ into web
   sessions. Its update channel is the plugin marketplace mechanism, not
   `agentpack update` — regenerate and re-tag the plugin when the pack
   releases.
3. **What does not cross.** User-level `~/.claude` (memory, user settings,
   user-scope hooks) does not travel into web sandboxes except via lane 2's
   plugin subset. Ambient instructions downgrade to on-invoke skills off the
   terminal; user hooks and other terminal-only surfaces have no web home.
   `.mcp.json` under `~/.claude` is reference output — Claude Code reads
   user-scope MCP servers from `~/.claude.json`, which AgentPack never edits.

## Triggers (no daemons)

`agentpack update` is always the primitive; everything else is a notifier. The
recommended nudge is a SessionStart hook running
`agentpack update --check --quiet` (exit 10 = updates available); pack-repo CI
regenerating the plugin and opening update PRs is the S4 phase of
[`sync-design.md`](./sync-design.md). There is deliberately no file-watcher or
resident process, and no flag combination auto-applies exec-bearing updates —
consent is `--allow-exec` at a terminal or a PR review, never absent.
