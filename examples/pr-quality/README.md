# Pull Request Quality Pack

A complete example AgentPack for pull request review workflows across Claude Code, Codex, Cursor, and the generic AGENTS.md target (ChatGPT Apps output is experimental — see the manifest's compatibility block).

Profiles:

- `safe`: instructions, rules, skill, command only
- `standard`: adds security reviewer subagent
- `full`: adds formatting hook and optional GitHub MCP
- `enterprise`: full plus policy requirements
