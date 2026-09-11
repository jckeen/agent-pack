# @agentpack/cli

The `agentpack` command-line tool: validate, inspect, plan, export, install,
update, uninstall, verify, and roll back [AgentPacks](https://github.com/jckeen/agent-pack)
— portable, signable packages of agent configuration (instructions, skills,
commands, hooks, MCP servers) that compile to native files for Claude Code,
Codex, Cursor, ChatGPT, and generic runtimes.

The packages are not published on npm yet. Build from source with Node.js
and pnpm as specified in the root `package.json`:

```bash
git clone https://github.com/jckeen/agent-pack
cd agent-pack
pnpm install
pnpm --filter @agentpack/cli... build
(cd packages/cli && pnpm link --global)
agentpack --version

agentpack install github:jckeen/agent-pack@master#examples/pr-quality \
  --target claude-code --profile safe --project ./my-project --yes
```

If pnpm reports that its global binary directory is missing, run `pnpm setup`
and reopen your shell before linking. Keep the checkout: the linked command
uses its built files. Rebuild the CLI after pulling source updates.

Installs are planned, consented, WAL-protected, and reversible: every install
writes a deterministic `AGENTPACK.lock`, backups, and a hash-chained history —
`agentpack verify` detects drift, `agentpack rollback` restores. Git is the
default distribution mechanism; a hosted registry is optional.

- Repository and project README: <https://github.com/jckeen/agent-pack>
- CLI reference: [`docs/cli.md`](https://github.com/jckeen/agent-pack/blob/master/docs/cli.md)
- All guides: [`docs/`](https://github.com/jckeen/agent-pack/tree/master/docs)

License: MIT
