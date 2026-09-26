# Use AgentPack with ChatGPT and Claude

Start with [the portable research and decisions pack](../examples/portable-workflow/README.md).
It turns supplied material into a research brief and a decision memo, without
setting up an MCP server or API key. Build the CLI using the
[quickstart](../README.md#quickstart-5-minutes), then run `agentpack guide` from the
checkout. You can inspect the guide anywhere; its example paths are relative to
the repository root.

## Choose the destination

| You want to use          | Guide                             | Export                         | What you do in the product                                                             |
| ------------------------ | --------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| ChatGPT with plugins     | `agentpack guide chatgpt`         | `pack agent-plugin`            | Register the directory in a supported local marketplace and install through the client |
| ChatGPT Project guidance | `agentpack guide chatgpt-project` | `pack export --target chatgpt` | Paste `project-instructions.md` into Project instructions                              |
| Claude skills            | `agentpack guide claude`          | `pack chat`                    | Upload the native skill ZIPs; optionally paste Project guidance                        |
| Claude with plugins      | `agentpack guide claude-plugin`   | `pack plugin`                  | Package or register the directory using the client's custom plugin flow                |

`guide` is read-only and does not require a manifest. `--json` returns a `setup`
message and `routes`; each route includes argument arrays in `commands`, expected
`artifacts`, `nextSteps`, `limitations`, and official `sources`. The arrays omit
the `agentpack` executable so callers can invoke their chosen CLI entry point.
Unknown surfaces fail with a usage error.

ChatGPT's portable plugin format carries skills and MCP configuration. Local
plugin installation is a separate marketplace/client step; exporting a directory
is not a direct upload to a chat. Follow the
[official packaging and local testing instructions](https://developers.openai.com/plugins/build/plugins).
If that route is unavailable in your client, use
[Project instructions](https://learn.chatgpt.com/docs/projects).

Claude supports [skill ZIP uploads](https://support.claude.com/en/articles/12512180-use-skills-in-claude)
and [plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude).
Check your account and organization controls before choosing the route. AgentPack's
`pack chat` command specifically emits Claude skill ZIPs and manual recipes; it
is not a general ChatGPT exporter. Menu names and availability can change, so use
the linked official guides when the product differs from the printed steps.

## Know what travels

| Pack content           | Portable plugin                          | Claude skill bundle                     | ChatGPT Project export                      |
| ---------------------- | ---------------------------------------- | --------------------------------------- | ------------------------------------------- |
| Native skill           | `skills/` folder                         | Uploadable ZIP                          | Skill body is not emitted                   |
| Instruction            | On-invoke guidance skill                 | Guidance skill plus Project text        | Project text                                |
| Remote MCP declaration | `mcp.json` if representable              | Connector recipe                        | Experimental metadata, not a working server |
| Hook or subagent       | Vendor extension, not portable execution | Not emitted as an executable capability | Unsupported                                 |

Project guidance is why the starter includes an instruction atom as well as native
skills. No route transfers conversation history, account memory, connected-service
credentials, or the application's built-in tools. Host permission controls still
apply. Read exporter warnings, especially when using packs beyond this starter.
The legacy `chatgpt` adapter also emits developer scaffolding: command stubs are
not a working app. See [adapter details](./adapters.md).

## Verify your first use

The CLI tests execute each guide command into a temporary output directory and
check that meaningful workflow content reaches the advertised artifacts. They
verify compilation, not account installation or model behavior.

After manual installation, open a new chat and use the sample prompts in the
[starter README](../examples/portable-workflow/README.md). Confirm the skill is
available, citations refer to supplied material, uncertainty is retained, and the
recommendation respects the stated constraint. Remove the plugin or skill through
the host's settings if you do not want it retained. Project text is removed in
Project settings. AgentPack's `uninstall` does not manage those account changes.

## Other systems AgentPack can support

The existing core supports manifest validation, permission/risk planning, adapters,
imports, local and Git-source installs, lockfiles, drift detection, updates, and
rollback. The connector exposes guidance through MCP; it does not execute a
business workflow. Registry publishing and hosted infrastructure are separate
from a local starter. See [the architecture and capability specification](../ISA.md)
and [release status](../STATUS.md).

Reusable document briefs, meeting preparation, editorial review, and decision
support can use the same skills-first pattern as this starter. Workflows that
read external accounts need a separately tested connector and authentication path.
Scheduling, interactive app hosting, and account provisioning need product-specific
integrations; a successful pack export alone does not provide them. The
[dated platform research](./platform-research-2026-09-26.md) records the evidence
behind these distinctions; it is a snapshot, not an implementation tracker.
