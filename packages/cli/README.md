# @agentpack/cli

The `agentpack` command-line tool: validate, inspect, plan, export, install,
update, uninstall, verify, and roll back [AgentPacks](https://github.com/jckeen/agent-pack)
— portable, signable packages of agent configuration (instructions, skills,
commands, hooks, MCP servers) that compile to native files for Claude Code,
Codex, Cursor, ChatGPT, and generic runtimes.

```bash
npm i -g @agentpack/cli

agentpack install github:jckeen/agent-pack@master#examples/pr-quality \
  --target claude-code --profile safe --project ./my-project --yes
```

Installs are planned, consented, WAL-protected, and reversible: every install
writes a deterministic `AGENTPACK.lock`, backups, and a hash-chained history —
`agentpack verify` detects drift, `agentpack rollback` restores. Git is the
default distribution mechanism; a hosted registry is optional.

- Repository and project README: <https://github.com/jckeen/agent-pack>
- CLI reference: [`docs/cli.md`](https://github.com/jckeen/agent-pack/blob/master/docs/cli.md)
- All guides: [`docs/`](https://github.com/jckeen/agent-pack/tree/master/docs)

License: MIT
