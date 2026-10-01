# AgentPack

**Package, share, and manage agent configuration across ChatGPT, Claude, Codex, Cursor, and other compatible tools.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/jckeen/agent-pack/actions/workflows/ci.yml/badge.svg)](https://github.com/jckeen/agent-pack/actions/workflows/ci.yml)

AgentPack is an open-source format, compiler, and CLI for reusable agent workflows.
One `AGENTPACK.yaml` describes instructions, skills, rules, commands, subagents,
hooks, and MCP configuration. Choose a destination to generate its configuration
files or an installable package, with explicit limits on what carries over.

- **Share a workflow:** export skills and plugins for supported ChatGPT and Claude
  clients, or generate Project instructions for manual setup.
- **Manage local configuration:** install into Codex, Claude Code, Cursor, or a
  generic project layout, then detect drift, update, roll back, or uninstall.
- **Review what you install:** inspect declared permissions, computed risk, and
  proposed changes; apply install policy before configuration reaches a project.

AgentPack manages configuration and packages. The host runs the workflow and
controls tool access. An export does not create an account, deploy an app, connect
services, or make every feature work in every product.

## Choose your destination

| Destination                    | AgentPack route                | What it provides                                                                                | What remains with the host                                                                 |
| ------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **ChatGPT plugins**            | `pack agent-plugin`            | Portable plugin directory with skills and representable MCP configuration                       | Marketplace registration, installation, authentication, and supported-client access        |
| **ChatGPT Projects**           | `pack export --target chatgpt` | Instruction text for Project settings                                                           | Manual copy/paste; other emitted files are experimental app scaffolding, not a working app |
| **Claude skills and Projects** | `pack chat`                    | Skill ZIPs, Project instructions, and remote connector recipes when present                     | Manual upload/setup and account or organization controls                                   |
| **Claude plugins**             | `pack plugin`                  | Claude plugin directory                                                                         | Client-specific installation; executable components need a compatible runtime              |
| **Codex**                      | `install --target codex`       | `AGENTS.md`, native skills, agent definitions, hooks, and MCP configuration where representable | Runtime support, tool permissions, and required external services                          |
| **Claude Code**                | `install --target claude-code` | `CLAUDE.md`, skills, commands, agents, hooks, and MCP configuration                             | Runtime support, tool permissions, and required external services                          |
| **Cursor**                     | `install --target cursor`      | `AGENTS.md`, rules, and MCP configuration; skill content is inlined                             | This adapter does not emit native skill folders or executable hooks                        |
| **Other tools**                | `pack export --target generic` | `AGENTS.md`, skill folders, and descriptive metadata                                            | Verify how the chosen client discovers files and which features it supports                |

These rows describe **AgentPack's implementation**, not every capability of the
products. For example, [Cursor supports native skills](https://cursor.com/docs/skills),
but this repository's Cursor adapter currently inlines them. The generic target
is a fallback format, not certification of a particular client.

[OpenAI documents portable plugins](https://developers.openai.com/plugins/build/plugins)
and [skills shared by ChatGPT and Codex](https://learn.chatgpt.com/docs/build-skills).
Claude documents [skill uploads](https://support.claude.com/en/articles/12512180-use-skills-in-claude)
and [plugin packaging](https://code.claude.com/docs/en/plugins).
A supported format does not guarantee identical behavior across accounts or clients.

See the [ChatGPT and Claude onboarding guide](./docs/chatgpt-claude.md) for manual
setup, and [adapter details](./docs/adapters.md) for exact mappings and limitations.
`agentpack guide` prints the consumer routes and example commands; `--json` exposes
them as structured data.

## Why AgentPack

A skill folder or plugin is useful on its own. AgentPack adds a manifest that
combines components, profiles that select what to include, and a managed lifecycle
for local installs. Shared instruction files such as `AGENTS.md` and `CLAUDE.md`
can retain user-authored content while AgentPack manages its own contribution.

Cross-platform configuration still needs translation. A native subagent can become
unsupported content on another target; a hook needs the host's execution model;
Project instructions require a different setup from repository instructions.
AgentPack provides adapters and export reports so you can review those differences
before adopting a workflow. Check the selected target's documentation rather than
treating a portability label as a guarantee of runtime compatibility.

## Quickstart (≤5 minutes)

Build the CLI from source; release and hosted-registry promotion are tracked in
[#63](https://github.com/jckeen/agent-pack/issues/63). Local packs and Git sources
work without a hosted registry account. Use the Node and pnpm requirements in
[`package.json`](./package.json).

**1. Clone and build:**

```bash
git clone https://github.com/jckeen/agent-pack
cd agent-pack
pnpm install --frozen-lockfile
pnpm --filter @agentpack/cli... build

# Use the built CLI from this checkout for the following examples:
alias agentpack="node $(pwd)/packages/cli/dist/index.js"
```

For a command that persists across shells, run `(cd packages/cli && pnpm link --global)`.
If pnpm needs a global binary directory, run `pnpm setup`, reopen the shell, and
link again. Keep the checkout and rebuild after pulling updates.

**2. Try a workflow in ChatGPT or Claude:**

```bash
agentpack guide
agentpack validate examples/portable-workflow

# ChatGPT portable plugin directory:
agentpack pack agent-plugin examples/portable-workflow --profile safe --out dist/chatgpt-plugin

# Claude skill ZIPs and Project instructions:
agentpack pack chat examples/portable-workflow --profile safe --out dist/claude-skills
```

Follow the [starter's setup and trial prompts](./examples/portable-workflow/README.md).
The starter turns supplied material into a research brief and decision memo.
Exports create files; account installation is manual. For Project-only setup or a
Claude plugin, use `agentpack guide chatgpt-project` or `agentpack guide claude-plugin`.

**3. Or install into a local coding project:**

```bash
# Preview a Codex install without changing the project:
agentpack install examples/pr-quality --target codex --profile safe --project ./my-project --dry-run

# Apply, check, and remove it:
agentpack install examples/pr-quality --target codex --profile safe --project ./my-project --yes
agentpack verify agentpack.pr-quality --project ./my-project
agentpack uninstall agentpack.pr-quality --project ./my-project --yes
```

Choose `--target claude-code`, `cursor`, or `generic` for the corresponding local
layout. A missing project directory is created during the consented install, not
the dry run. To install from Git instead of a local path:

```bash
agentpack install github:jckeen/agent-pack@master#examples/pr-quality \
  --target claude-code --profile safe --project ./my-claude-project --dry-run
```

Use a pinned Git ref when you need a stable source. See [Git sources](./docs/git-source.md)
and [install, verify, rollback, and uninstall](./docs/install.md).

## What's in a pack?

The manifest combines **atoms**: instructions, rules, skills, commands, subagents,
hooks, MCP server declarations, and other configuration types. A profile selects
which atoms participate in an export or install. Profile names and contents belong
to the pack; inspect them before choosing one.

```bash
agentpack inspect examples/pr-quality
agentpack plan examples/pr-quality --target codex --profile safe
agentpack init
```

`init` scaffolds a pack in the current directory. Existing setups can be imported
from Claude Code, Codex, manually assembled custom-GPT bundles, and portable Agent
Plugins; see the [CLI reference](./docs/cli.md) for formats and caveats.

### Skills and plugin formats

AgentPack uses [Agent Skills](https://agentskills.io/home) for reusable skill
folders. Its validators and conformance tests check emitted skill structure.
That verifies the package format, not the model's behavior when the skill runs.

`pack agent-plugin` emits the [Agent Plugins](https://agent-plugins.org/) format:
root `plugin.json`, skills, and representable MCP configuration. Commands,
subagents, and hooks use AgentPack's vendor extension rather than becoming portable
execution. Instruction/rule guidance is bridged to an on-invoke skill; it does not
become account-wide instructions. `pack plugin` emits the Claude-specific format.

`pack mcpb` creates a desktop extension manifest bundle for an eligible local MCP
server. It does not bundle arbitrary server implementations or dependencies.
The [connector prototype](./packages/connector/README.md) exposes pack guidance as
MCP prompts and resources; hosting, authentication interoperability, and client
support require separate verification.

## Install safety and verification

Managed local installs use a write-ahead log, backups, per-file checksums, an
`AGENTPACK.lock`, and history. Supported shared files are merged rather than
wholesale replaced; verification checks the pack's recorded contribution.
Conflicts and unsupported mappings still need review.

Install policy can restrict sources and risk. Critical plans and unverified
executable content have explicit consent gates; `--yes` alone does not bypass
them. These controls govern AgentPack installation, not every action a host agent
might later take. Standalone exports also need review before manual installation.

Signing and signature verification are available through the registry workflow;
Git-source installs do not currently establish signed publisher identity. See
[security](./docs/security.md), [policy](./docs/policy.md), and
[signatures](./docs/signatures.md) for the exact guarantees and flags.

## Repository and development

| Path                                         | Purpose                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`packages/core`](./packages/core)           | Manifest validation, adapters, exporters, planning, install lifecycle, and signing |
| [`packages/cli`](./packages/cli)             | `agentpack` command                                                                |
| [`packages/connector`](./packages/connector) | MCP guidance prototype                                                             |
| [`packages/db`](./packages/db)               | Registry schema and queries                                                        |
| [`apps/registry`](./apps/registry)           | Registry web application                                                           |
| [`examples`](./examples)                     | Packs to inspect, export, and try                                                  |
| [`packs`](./packs)                           | First-party packs, including the `sync-check` session-start drift check            |
| [`action`](./action)                         | Reusable GitHub Action that validates a pack repo and exports a Claude plugin      |
| [`docs`](./docs)                             | Format, adapters, CLI, installation, and security guides                           |

```bash
pnpm verify                  # typecheck, lint, tests with coverage, production builds
bash scripts/check-doc-truth.sh
pnpm dev                     # run the registry UI locally
```

The hosted registry is optional. Local and Git-source workflows are the starting
point; see [registry setup](./docs/registry.md), [current status](./STATUS.md), and
the [roadmap](./Plans/ROADMAP.md) for release and infrastructure gates. Enterprise
work remains subject to its [explicit gate](./Plans/PHASE-6-GATE.md).
The [project specification](./ISA.md) records the implementation's acceptance criteria.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md).
Issues and PRs are welcome, particularly reports of a documented workflow failing
on a specific client. Report vulnerabilities through [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE). The format, CLI, adapters, connector, and registry code are open
source. Third-party clients, hosting, and connected services have their own terms.
