# `workgraph` CLI

The CLI lives in [`../packages/cli`](../packages/cli) and exposes the same engine as `@workgraph/core` and the registry. Every command is read-only on your project tree except `init` (scaffolding) and `pack export` (writes only into `--out`).

## `workgraph init`

```
workgraph init [--force]
```

Scaffolds a starter `AGENTPACK.yaml`, a minimal instruction atom, and an example skill atom in the current directory. `--force` overwrites existing files.

## `workgraph validate [path]`

```
workgraph validate [path]
```

Loads `AGENTPACK.yaml` (or the file/directory at `[path]`), runs the schema + semantic validators, and prints errors/warnings. Exits non-zero on failure.

## `workgraph inspect [path]`

```
workgraph inspect [path] [--profile <name>]
```

Prints:

- metadata (name, id, version, publisher, tags)
- compatibility matrix
- profiles (with include/exclude entries)
- atoms (id, type, risk, description)
- preview for `--profile` (default `safe`): permission summary and computed risk

## `workgraph plan [path]`

```
workgraph plan [path] [--target <target>] [--profile <profile>] [--only <ids>]
```

Resolves atoms for the profile, computes risk + permissions, runs the adapter to produce a file plan, and prints:

- pack id @ version
- target / profile / risk badge
- selected atoms
- permission summary (categorized by risk, with required secrets / declared network domains / declared shell commands)
- file plan (every path the export would write)
- warnings (risk reasons + adapter warnings + secrets reminders)

`--only` accepts a comma-separated list of atom IDs to further filter the resolved set.

## `workgraph pack export [path]`

```
workgraph pack export [path] [--target <target>] [--profile <profile>] [--out <dir>] [--only <ids>] [--no-strict]
```

The same engine as `plan`, but writes the planned files to `--out`. `--no-strict` will write files even when the manifest has validation errors (useful for partial-export debugging).

The export refuses to write outside `--out` (path-containment check in the exporter).

## `workgraph doctor`

Prints environment checks:

- Node ≥ 18
- pnpm, npm, git availability
- Presence of `AGENTPACK.yaml` in the current directory

Use it as a first stop when something looks wrong.

## Target platforms

`claude-code`, `codex`, `cursor`, `chatgpt`, `generic`.

## Profiles

`safe`, `standard`, `full`, `enterprise` (convention — pack authors are free to define more).

## Exit codes

| Code | Meaning                                          |
|------|--------------------------------------------------|
| `0`  | success                                          |
| `1`  | runtime error (e.g. validation failure)          |
| `2`  | bad invocation (e.g. unknown target/profile)     |

## Examples

```bash
# Validate the bundled example pack
workgraph validate examples/pr-quality

# Show full metadata + safe-profile preview
workgraph inspect examples/pr-quality --profile standard

# Plan a Claude Code install at the safe profile — should print LOW risk
workgraph plan examples/pr-quality --target claude-code --profile safe

# Plan at the full profile — warns about hook, shell.execution, GitHub MCP, GITHUB_TOKEN
workgraph plan examples/pr-quality --target claude-code --profile full

# Export all five targets
for t in claude-code codex cursor chatgpt generic; do
  workgraph pack export examples/pr-quality \
    --target "$t" --profile safe \
    --out "dist/$t"
done
```
