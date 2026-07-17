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
  tags: ["tag-a", "tag-b"]

compatibility:
  targets:
    claude-code: { status: supported }
    codex: { status: supported }
    cursor: { status: partial }
    chatgpt: { status: experimental }
    generic: { status: supported }

permissions:
  filesystem: { read: ["."], write: ["."] }
  shell: { execution: optional, commands: ["npm run format"] }
  network: { access: optional, domains: ["api.github.com"] }
  secrets:
    required:
      - name: "GITHUB_TOKEN"
        description: "Optional — only for the GitHub MCP server."
        required_for: ["mcp_server:github"]
  mcp: { servers: ["github"] }
  external_apis: ["github"]

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
    include: ["*"]

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
    permissions: ["shell.execution", "filesystem.write"]
    lifecycle:
      events:
        claude-code: ["PostToolUse"]
        codex: ["PostToolUse"]
        generic: ["after_edit"]

exports:
  default_profile: safe
  output_dir: dist

adapters:
  claude-code: { enabled: true }
  codex: { enabled: true }
  cursor: { enabled: true }
  chatgpt: { enabled: true, experimental: true }
  generic: { enabled: true }
```

## Atom rules

- IDs are `<type>:<slug>` (e.g. `skill:code-review`). The prefix must match the declared `type`.
- IDs are globally unique within a pack.
- `path` is relative to the pack root (folder containing `AGENTPACK.yaml`). An atom may declare an inline `body` instead of a `path` (at most one of the two).
- `path` may be omitted entirely only when the atom declares `variants` (see Target variants).
- `risk_level` is one of `low | medium | high | critical`.
- Atoms may carry a `permissions` array of category strings (see Security).
- Atom-type-specific fields (`invocation`, `lifecycle`, `transport`, `env`, `scope`, `skill_format`) are passed through and consumed by the adapters that understand them.

## Target variants

One logical atom often needs a Claude-specific, Codex-specific, or generic body while keeping a single identity ([#133](https://github.com/jckeen/agent-pack/issues/133)). An atom may declare a `variants` map keyed by target platform; each entry sets **exactly one** of `path` (a pack-relative file, same trust rules as `atom.path`) or `body` (inline content):

```yaml
atoms:
  - id: "instruction:release-workflow"
    type: instruction
    name: "Release Workflow"
    description: "One shared release workflow with per-target bodies."
    path: "atoms/instructions/release-workflow.md" # default body
    risk_level: low
    variants:
      claude-code:
        path: "atoms/instructions/release-workflow.claude-code.md"
      codex:
        path: "atoms/instructions/release-workflow.codex.md"
      generic:
        body: "Generic runtimes: run the checks, then tag."
```

Semantics:

- **One id, per-target content.** Installing the same pack to two targets records the same atom identity in the plan and lockfile; only the compiled content differs.
- **Selection order** (exact target match, no cross-target fallback): `variants[<target>]` → the atom's default `path`/`body` → none. Selection runs in the planner, before the adapter — adapters never see the `variants` map.
- **Missing variant, no default** → the atom is reported in the plan's `unsupportedAtoms` with a warning, and `observedFidelity` degrades to `partial` — never a silent drop. `agentpack validate` warns up front (`atom.variant_target_gap`) when a variant-only atom leaves a declared compatibility target uncovered.
- **Import folds preserve foreign variants.** `agentpack import --into` carries another runtime's variants over to the re-imported atom; only the fold source's own variant is superseded by the fresh content.

## Profile semantics

- `include` accepts atom IDs and wildcard `<type>:*` patterns (and the global `*`).
- `exclude` is applied after `include`. `exclude` patterns that match nothing produce a validation warning, not an error.
- When `include` is omitted, all atoms are included by default.
- An unknown profile referenced from the CLI is an error (the validator catches it).

## Compatibility statuses

- `supported` — adapter produces a complete, conservative output.
- `partial` — adapter maps a subset of atoms, or compiled output still needs
  target-specific semantic verification; limitations surface in notes or
  warnings.
- `experimental` — adapter output should be reviewed before use (e.g., ChatGPT).
- `unsupported` — adapter will refuse most atom types for this target.

## Versioning

The top-level `agentpack:` field is the manifest schema version. MVP requires `1.x`. Pack metadata `version:` is independent and follows SemVer.
