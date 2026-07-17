# Pull Request Quality Pack

A complete example AgentPack for pull request review workflows across Claude Code, Codex, Cursor, and the generic AGENTS.md target (ChatGPT Apps output is experimental — see the manifest's compatibility block).

Profiles:

- `safe`: instructions, rules, skill, command only
- `standard`: adds security reviewer subagent
- `full`: adds formatting hook and optional GitHub MCP
- `enterprise`: full plus policy requirements

## Try it

### Prerequisites

- Node.js ≥ 22 and pnpm.
- The `agentpack` CLI. It is not on npm yet, so build it from source:

  ```bash
  git clone https://github.com/jckeen/agent-pack.git
  cd agent-pack && pnpm install && pnpm build
  alias agentpack="node $PWD/packages/cli/dist/index.js"
  ```

### Install

From any project directory (the pack itself is fetched from GitHub — no registry, no account):

```bash
agentpack install github:jckeen/agent-pack@master#examples/pr-quality
```

The CLI resolves `master` to a commit SHA via the GitHub API, fetches only the
`examples/pr-quality` subtree from `raw.githubusercontent.com`, and prints an
install plan before touching anything:

```text
Installed from git: github:jckeen/agent-pack@master → <sha12>#examples/pr-quality

Install plan: agentpack.pr-quality@0.1.0 → claude-code (safe)
Risk:  LOW

Permissions:
  • filesystem.read: Read files in the project (atoms: skill:code-review, command:pr-summary)
  • git.operations: Run git read operations (status/diff/log) (atoms: command:pr-summary)

Create (4):
  + .claude/commands/pr-summary.md
  + .claude/skills/code-review/references/checklist.md
  + .claude/skills/code-review/SKILL.md
  + CLAUDE.md

Install agentpack.pr-quality@0.1.0 → /your/project? [y/N]
```

The `[y/N]` prompt is the consent gate: you are shown the computed risk level,
the exact permissions the pack's atoms use, and every file that will be
created or modified — before anything is written. Answer `y` (or pass `--yes`
in scripts) and the files above land in your project, plus:

- `AGENTPACK.lock` — pins the resolved commit SHA and a sha256 for every
  installed file (commit this for reproducibility).
- `.agentpack/` — install manifest, backups, and an append-only history log
  (add it to `.gitignore`; the CLI prints the exact entries to add).

Defaults: `--target claude-code`, and this pack declares `safe` as its default
profile. Pass `--dry-run` to see the plan without writing anything.

### Higher profiles mean more consent

The `full` profile ships a formatting **hook** (a shell command run on agent
lifecycle events) and a GitHub **MCP server** (a launch config run on your
next agent session) — author-supplied code that executes on your machine. The
CLI refuses these implicitly, even with `--yes`:

```bash
agentpack install github:jckeen/agent-pack@master#examples/pr-quality --profile full
# ✗ Computed risk level is CRITICAL. Re-run with --allow-critical …
# ✗ This pack ships executable content and the install is NOT signature-verified:
#   • hook:post-edit-format (hook) — shell command run on agent lifecycle events
#   • mcp_server:github (mcp_server) — launch config run on your next agent session
#   Re-run with --allow-exec …
```

Each gate needs its own explicit, greppable flag (`--allow-critical`,
`--allow-exec`) because git-source installs are not signature-verified — you
are trusting the repo at that SHA. A registry install verified with
`--require-sig` would not need `--allow-exec`.

### Verify

```bash
agentpack verify agentpack.pr-quality
# ✓ agentpack.pr-quality clean — no drift.
```

Compares every installed file against the sha256s in `AGENTPACK.lock` and
reports drift (edited, missing, or foreign files). Add `--chain` to also check
the integrity of the local install-history hash chain.

### Update

```bash
agentpack update agentpack.pr-quality
# ✓ agentpack.pr-quality up to date (branch, <sha12>)
```

Because the install tracked the `master` branch, `update` re-resolves the
branch head and applies changes if the pack moved (`--dry-run` to preview).
Installing with `@<tag>` or a full SHA pins instead — `update` then only
reports, never moves past your pin.

### Uninstall / undo

```bash
agentpack uninstall agentpack.pr-quality
```

Prints a removal plan (same consent shape as install), removes the pack's
files, and unmerges the pack-marked section from shared files like `CLAUDE.md`
instead of deleting them. Files the pack backed up are restored. To undo other
operations, `agentpack history` lists every install/update/uninstall and
`agentpack rollback` restores the previous state.
