# Security Model

Agent packages can alter agent behavior, expose data, run commands, install hooks, call APIs, access secrets, and write files. Treat them like software supply chain artifacts.

## Security principles

1. Default to safe profiles.
2. Never hide permissions.
3. Show file plans before writes.
4. Warn loudly on hooks, shell execution, secrets, network, repo write, package install.
5. Support rollback.
6. Prefer explicit user approval for dangerous behavior.
7. Keep registry review status visible.
8. Make provenance and checksums first-class.

## Risk levels

### Low

Examples:

- instructions
- rules
- templates
- skills without scripts
- eval prompts without code execution

### Medium

Examples:

- subagents with file read access
- commands that inspect repository state
- skills with optional scripts not auto-executed
- context packs with internal/private data

### High

Examples:

- hooks
- shell execution
- MCP servers requiring secrets
- filesystem writes
- external API access
- repo modification

### Critical

Examples:

- shell execution + secrets + network + filesystem write
- package installation
- model/provider key access
- private context exfiltration risk
- browser automation plus user data

## Permission summary format

The installer and registry should show a human-readable summary:

```text
This pack wants to:

LOW RISK
- Add project instructions
- Install one code review skill

MEDIUM RISK
- Add a security-review subagent that can read repository files

HIGH RISK
- Add a hook that can run npm run format
- Configure GitHub MCP using GITHUB_TOKEN
- Access api.github.com
```

## Required permission categories

- filesystem read
- filesystem write
- shell execution
- network access
- secrets/env vars
- MCP server access
- external API access
- browser access
- repo modification
- git operations
- package installation
- user data access
- private context access
- model/provider key access

## Install profiles and security

### Safe

No hooks, no MCP secrets, no shell execution, no install scripts.

### Standard

Allows commands and subagents, but not dangerous automation by default.

### Full

Allows hooks, MCP, scripts, and automation with warnings.

### Enterprise

Requires:

- signatures
- lockfiles
- admin approval
- policy enforcement
- audit logs

## Provenance

Each published version should eventually include:

```json
{
  "packId": "workgraph.pr-quality",
  "version": "0.1.0",
  "source": {
    "type": "git",
    "repository": "https://github.com/workgraph/packs",
    "commit": "...",
    "tag": "..."
  },
  "builder": {
    "name": "workgraph-cli",
    "version": "0.1.0"
  },
  "createdAt": "..."
}
```

## Checksums

Generate checksums for:

- `AGENTPACK.yaml`
- atom files
- generated exports
- lockfile

## Future signatures

Support:

- Sigstore/cosign-style signing
- publisher keys
- registry verification
- enterprise trust policies

## Malicious package reporting

Registry should eventually support:

- report package
- quarantine package
- block publisher
- flag vulnerable version
- security advisory

## Rollback

Every actual install must write an uninstall manifest with:

- created files
- modified files
- original backups
- selected atoms
- profile
- target
- timestamp
