# AgentPack Standard

`AGENTPACK.yaml` is the single manifest for an AgentPack. This document is a working reference; the canonical JSON Schema lives at [`../schemas/AGENTPACK.schema.json`](../schemas/AGENTPACK.schema.json) and the runtime validator at [`../packages/core/src/schema/agentpack.schema.ts`](../packages/core/src/schema/agentpack.schema.ts).

## Manifest skeleton

```yaml
agentpack: "1.0"

metadata:
  id: "publisher.slug"
  name: "Human Name"
  slug: "slug"
  description: "One-sentence summary."
  version: "0.1.0"
  license: "MIT"
  publisher: "publisher"
  authors:
    - name: "Author"
      email: "author@example.com"
  tags: [ "tag-a", "tag-b" ]

compatibility:
  targets:
    claude-code: { status: supported }
    codex:       { status: supported }
    cursor:      { status: partial }
    chatgpt:     { status: experimental }
    generic:     { status: supported }

permissions:
  filesystem: { read: [ "." ], write: [ "." ] }
  shell:      { execution: optional, commands: [ "npm run format" ] }
  network:    { access: optional, domains: [ "api.github.com" ] }
  secrets:
    required:
      - name: "GITHUB_TOKEN"
        description: "Optional — only for the GitHub MCP server."
        required_for: [ "mcp_server:github" ]
  mcp: { servers: [ "github" ] }
  external_apis: [ "github" ]

profiles:
  safe:
    description: "Instructions, rules, skills, commands."
    include:
      - "instruction:project-defaults"
      - "rule:no-secret-edits"
    exclude:
      - "hook:*"
      - "mcp_server:*"
  full:
    include: [ "*" ]

atoms:
  - id: "instruction:project-defaults"
    type: instruction
    name: "Project Defaults"
    description: "Default project guidance for agents."
    path: "atoms/instructions/project-defaults.md"
    risk_level: low

  - id: "hook:post-edit-format"
    type: hook
    name: "Post Edit Format"
    description: "Runs project formatter after agent file edits."
    path: "atoms/hooks/post-edit-format.yaml"
    risk_level: high
    permissions: [ "shell.execution", "filesystem.write" ]
    lifecycle:
      events:
        claude-code: [ "PostToolUse" ]
        codex:       [ "PostToolUse" ]
        generic:     [ "after_edit" ]

exports:
  default_profile: safe
  output_dir: dist

adapters:
  claude-code: { enabled: true }
  codex:       { enabled: true }
  cursor:      { enabled: true }
  chatgpt:     { enabled: true, experimental: true }
  generic:     { enabled: true }
```

## Atom rules

- IDs are `<type>:<slug>` (e.g. `skill:code-review`). The prefix must match the declared `type`.
- IDs are globally unique within a pack.
- `path` is relative to the pack root (folder containing `AGENTPACK.yaml`).
- `risk_level` is one of `low | medium | high | critical`.
- Atoms may carry a `permissions` array of category strings (see Security).
- Atom-type-specific fields (`invocation`, `lifecycle`, `transport`, `env`, `scope`, `skill_format`) are passed through and consumed by the adapters that understand them.

## Profile semantics

- `include` accepts atom IDs and wildcard `<type>:*` patterns (and the global `*`).
- `exclude` is applied after `include`. `exclude` patterns that match nothing produce a validation warning, not an error.
- When `include` is omitted, all atoms are included by default.
- An unknown profile referenced from the CLI is an error (the validator catches it).

## Compatibility statuses

- `supported` — adapter produces a complete, conservative output.
- `partial` — adapter maps a subset of atoms; the rest surface as warnings.
- `experimental` — adapter output should be reviewed before use (e.g., ChatGPT).
- `unsupported` — adapter will refuse most atom types for this target.

## Versioning

The top-level `agentpack:` field is the manifest schema version. MVP requires `1.x`. Pack metadata `version:` is independent and follows SemVer.
