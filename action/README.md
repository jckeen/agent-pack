# AgentPack pack CI action

Composite GitHub Action for repos that _are_ an AgentPack (a personal config
pack, a team pack repo): on every push it validates the manifest and re-emits
the Claude Code plugin, so a broken pack never reaches consumers. This is the
pack-repo CI lane of sync S4 (`docs/sync-design.md` §5).

Reference it as `jckeen/agent-pack/action@master`. The `agentpack` CLI is not
published to npm yet — the action builds the CLI from this repo's source at
run time, so it works today with no registry and no published package.

## Usage

```yaml
# .github/workflows/pack-ci.yml in YOUR pack repo
name: Pack CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: jckeen/agent-pack/action@master
        with:
          pack-dir: "." # where AGENTPACK.yaml lives
          export-plugin: "true" # also compile the Claude Code plugin
          plugin-out: "dist-plugin"
      # Optionally publish dist-plugin as an artifact / commit it on tag:
      - uses: actions/upload-artifact@v4
        with:
          name: claude-code-plugin
          path: dist-plugin
```

## Inputs

| Input              | Default          | Meaning                                       |
| ------------------ | ---------------- | --------------------------------------------- |
| `pack-dir`         | `.`              | Directory containing `AGENTPACK.yaml`.        |
| `export-plugin`    | `true`           | Run `agentpack pack plugin` after validation. |
| `plugin-out`       | `dist-plugin`    | Output directory for the compiled plugin.     |
| `profile`          | _(pack default)_ | Install profile to compile.                   |
| `update-consumers` | _(empty)_        | **Not implemented yet** — see below.          |

Output: `plugin-dir` — absolute path of the compiled plugin (empty when
`export-plugin` is `false`).

## Consumer update PRs (`update-consumers`) — not yet implemented

The S4 design's third lane — dependabot-style PRs against consumer repos,
where the PR diff is exactly the update plan's files + lockfile and the PR
review is the consent gate — is declared as an input but **fails fast with an
error** if set, rather than pretending to work. Tracked in
[jckeen/agent-pack#113](https://github.com/jckeen/agent-pack/issues/113).
Until it ships, consumers pull updates with `agentpack update` (nudged by the
[`agentpack.sync-check`](../packs/sync-check/README.md) pack).

## Guarantees

- **Validate is the gate.** `agentpack validate` failing fails the job.
- **No hidden writes.** The action writes only `plugin-out` (plus the CLI
  build inside the action's own checkout), and touches no consumer repos.
- **Inputs are data, not code.** All inputs cross into shell via `env`, never
  inline `${{ }}` interpolation inside `run` scripts.

This repo's own CI exercises the action against `examples/pr-quality` on
every push (the `action-smoke` job in `.github/workflows/ci.yml`), so it
cannot rot silently.
