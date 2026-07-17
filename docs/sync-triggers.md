# Sync triggers — the S4 notifiers

`agentpack update` is always the primitive; nothing in AgentPack applies an
update on its own. Phase S4 of [`sync-design.md`](./sync-design.md) ships the
two sanctioned notifiers around that primitive: a SessionStart nudge pack for
the pull direction, and a pack-repo CI action for the push direction. There is
deliberately no daemon, no file-watcher, and no flag combination that
auto-applies exec-bearing updates.

## Pull: the `agentpack.sync-check` pack

A first-party pack (`packs/sync-check/`) whose single atom is a Claude Code
SessionStart hook running `agentpack update --check --quiet`. Exit code 10
("update available") prints one line:

```
AgentPack updates available — run: agentpack update
```

Everything else — up to date, offline, no `agentpack` binary on PATH, no packs
installed, hung network (bounded `timeout`) — is silent, exit 0. The hook is
read-only; the human runs `agentpack update` and goes through the normal
consent gates. It checks the current project and, when one exists, the
`~/.claude` user-scope install (sync S3).

Install it into a project, or into `~/.claude` for a nudge in every session:

```bash
agentpack install github:jckeen/agent-pack@master#packs/sync-check \
  --target claude-code --allow-exec            # project scope
agentpack install github:jckeen/agent-pack@master#packs/sync-check \
  --target claude-code --scope user --allow-exec   # user scope
```

`--allow-exec` is the standard consent gate for an unsigned hook-bearing pack.
Details and the tested contract: [`packs/sync-check/README.md`](../packs/sync-check/README.md);
the end-to-end gate lives in `packages/cli/tests/sync-check-hook.cli.test.ts`.

## Push: CI in the pack repo

A composite GitHub Action ([`action/`](../action/README.md), referenced as
`jckeen/agent-pack/action@master`) for repos that _are_ a pack: on every push
it runs `agentpack validate` and re-emits the Claude Code plugin
(`agentpack pack plugin`), building the CLI from this repo's source so no npm
package is required. This repo's own CI runs the action against
`examples/pr-quality` (the `action-smoke` job) so it cannot rot silently.

The third lane — dependabot-style `agentpack update` PRs against registered
consumer repos, where the PR diff is exactly the update plan's files +
lockfile and PR review is the consent surface — is declared as the
`update-consumers` input but **not yet implemented**: setting it fails the run
with a clear error. Tracked in
[jckeen/agent-pack#113](https://github.com/jckeen/agent-pack/issues/113).

## Explicitly not building

Per `sync-design.md` §5: no git post-merge hook by default (duplicates
SessionStart), no daemon or file-watcher (resident attack surface, no benefit
over session start), no registry push notifications (pull-based `--check`
keeps the registry optional).
