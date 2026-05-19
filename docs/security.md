# Security Model

AgentPacks can alter agent behavior, expose data, run commands, install hooks, call APIs, access secrets, and write files. Treat them like software supply-chain artifacts.

## Principles

1. **Default to safe profiles.** `exports.default_profile: safe` is recommended.
2. **Never hide permissions.** The plan output names every category and the atoms that requested it.
3. **Warn loudly** on hooks, shell execution, secrets, network, repo write, package install.
4. **Honest about platforms** — adapter outputs for evolving platform surfaces (ChatGPT Apps SDK, Codex hooks) are marked conservative/experimental.
5. **No silent capability escalation.** Pack-level `permissions:` declarations describe the *possible* surface; the **active** surface is determined by the resolved atom subset.
6. **Reversibility is a feature.** Every install writes a WAL-protected install manifest at `.workgraph/installed/<packId>.json` with per-file SHA-256 + backup paths, so `workgraph uninstall <packId>` restores the project to its pre-install state. The hash-chained `.workgraph/history.jsonl` lets `workgraph rollback` walk back through multiple installs.

## Permission categories

`filesystem.read`, `filesystem.write`, `shell.execution`, `network.access`, `secrets.env`, `mcp.server`, `external_api.access`, `browser.access`, `repo.modification`, `git.operations`, `package.installation`, `user_data.access`, `private_context.access`, `model_provider_key.access`.

Each category has a default risk level (`filesystem.read: low`, `shell.execution: high`, `package.installation: critical`, etc.). Atom-declared permissions are unioned across the included atom set.

## Implicit per-atom-type escalations

- `hook` atoms always imply `shell.execution + filesystem.write`.
- `mcp_server` atoms always imply `mcp.server`; with `env:` they also imply `secrets.env`.

## Risk computation

`computeRisk` returns the **max** over:

- Each included atom's declared `risk_level`.
- The implicit risk of each requested permission (`shell.execution → high`, `secrets.env → high`, `package.installation → critical`, …).
- The presence of high-risk atom types (`hook` → `high`).
- The presence of secrets-bearing MCP servers (`high`).
- Pack-level `permissions.package_installation: true` → `critical`.
- Pack-level `permissions.model_provider_key_access: true` → `critical`.
- The combo `shell + secrets + network + filesystem.write` (any source) → `critical`.

The result is `low | medium | high | critical`, with a human-readable `reasons[]` array surfaced in CLI warnings and the registry UI.

## Profiles and safety

| Profile     | Allowed                                                           | Disallowed                                                     |
|-------------|-------------------------------------------------------------------|----------------------------------------------------------------|
| `safe`      | instructions, rules, skills (no scripts), templates, evals        | hooks, MCP-with-secrets, install scripts, shell execution      |
| `standard`  | + commands, subagents (no privileged tools)                       | hooks, MCP-with-secrets                                        |
| `full`      | hooks, MCP, scripts, automation (warnings required)               | —                                                              |
| `enterprise`| `full` + policy requirements (signature, lockfile, admin approval)| —                                                              |

The convention is enforced by the pack author in `profiles:` blocks. The validator surfaces wildcard mismatches and unresolved references.

## Secrets

`permissions.secrets.required` lists secrets the pack may need at runtime. Each secret may declare `required_for: [ "<atom_id>" | "<type>:*" ]`. The permission-summary engine only surfaces a secret when an atom it is required for is in the resolved set.

## Future security work (Phase 4+)

- Sigstore/cosign-style signing on published versions
- Verified-publisher status in the registry
- Automated security scans, malicious-package reports, quarantine
- Lockfiles with atom-level checksums
- Enterprise policy-as-code (allowlists, blocklists, admin approval flows)

## Anti-features in MVP

- The CLI **never writes outside `--out`** during `pack export`. The export planner enforces this with a path-containment check.
- The ChatGPT adapter **never claims** automatic installation; output is a skeleton that must be reviewed and registered manually.
- No adapter silently drops dangerous atoms — they appear in `warnings[]` and `unsupportedAtoms[]` on the install plan.
