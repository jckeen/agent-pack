# AgentPack Sync Check (`agentpack.sync-check`)

A first-party pack with exactly one atom: a Claude Code **SessionStart** hook
that runs a read-only `agentpack update --check --quiet` and prints a one-line
nudge when any installed pack's upstream has moved:

```
AgentPack updates available — run: agentpack update
```

This is the recommended notifier from `docs/sync-design.md` §5 — the sync
feature shipping _as a pack_. It never applies anything: `agentpack update`
(with its consent gates) is always the primitive; this hook is only the nudge.

## Contract

- **Read-only.** `update --check` performs zero writes; so does the hook.
- **Offline-silent.** Missing `agentpack` binary, no network, no packs
  installed, or a hung server: no output, exit 0. A nudge that errors on
  every session start is worse than none.
- **Silent when current.** Output only appears on exit code 10
  ("update available").
- **Bounded.** The check runs under `timeout` (default 10s, override with
  `AGENTPACK_SYNC_CHECK_TIMEOUT`); the hook entry also carries a 15s
  host-side timeout.
- **Both scopes.** Checks the current project, plus the `~/.claude`
  user-scope install when one exists (sync S3).

These are asserted end-to-end in
`packages/cli/tests/sync-check-hook.cli.test.ts`.

## Install

```bash
# Into a project (nudge at that project's session start):
agentpack install github:jckeen/agent-pack@master#packs/sync-check \
  --target claude-code --allow-exec

# Into ~/.claude (nudge in every session):
agentpack install github:jckeen/agent-pack@master#packs/sync-check \
  --target claude-code --scope user --allow-exec
```

`--allow-exec` is required because the pack ships a hook and is not yet
signed — the same consent gate every exec-bearing pack goes through. Review
`atoms/hooks/scripts/sync-check.sh` first; it is short on purpose.

## Uninstall

```bash
agentpack uninstall agentpack.sync-check
```
