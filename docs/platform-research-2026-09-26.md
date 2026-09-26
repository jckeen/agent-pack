> **Historical** — point-in-time record (2026-09-26). Do not act on this.

# ChatGPT, Claude, and AgentPack adoption research

This adoption-focused review combined separate OpenAI, Claude, and repository
research agents. It covers extension and workflow surfaces relevant to AgentPack,
not an exhaustive inventory of every feature or a signed-in account audit. Use
[the maintained onboarding guide](./chatgpt-claude.md) for setup and official
sources for current availability.

## Product evidence and local fit

| Surface                    | Official evidence inspected                                                                                                                                                     | Local implementation observed                                                     | Assessment at review time                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| ChatGPT Projects           | [Projects](https://learn.chatgpt.com/docs/projects)                                                                                                                             | `packages/core/src/adapters/chatgpt.ts` emits instruction atoms as Project text   | Useful manual fallback; no Project provisioning API integration                                   |
| ChatGPT plugins and skills | [Plugin packaging](https://developers.openai.com/plugins/build/plugins)                                                                                                         | `exports/exportAgentPlugin.ts` emits root manifest, skills, and MCP               | Best native skill route, with manual marketplace/client installation                              |
| ChatGPT apps/MCP           | [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)                                                                                                   | ChatGPT adapter produces inert command stubs; connector exposes prompts/resources | A pack is not a deployed app or authenticated production connector                                |
| Custom GPTs                | [GPT Actions](https://developers.openai.com/api/docs/actions/introduction)                                                                                                      | `importer/buildChatgptManifest.ts` consumes manually assembled input              | Does not reproduce managed retrieval or implement imported Actions                                |
| ChatGPT scheduling         | [Scheduled tasks](https://learn.chatgpt.com/docs/automations)                                                                                                                   | Skills can express the task; no inspected schedule exporter                       | A scheduling recipe is feasible, but requires host setup and a successful manual run              |
| Codex                      | [Projects and local folders](https://learn.chatgpt.com/docs/projects)                                                                                                           | `adapters/codex.ts` emits instructions, skills, agents, hooks, MCP                | Existing managed local install route; not the consumer chat onboarding path                       |
| Claude Projects and skills | [Projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects), [Skills](https://support.claude.com/en/articles/12512180-use-skills-in-claude) | `exports/exportChat.ts` emits Project text and ZIPs                               | Useful manual route; account/admin access must be checked                                         |
| Claude plugins             | [Plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)                                                                                                | `exports/exportPlugin.ts` emits native Claude plugin directories                  | Skills reach chat; executable components depend on the runtime                                    |
| Claude connectors          | [Remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)                                                               | Chat export emits recipes; connector package uses Bearer authentication           | Hosting and native authentication interoperability need live testing                              |
| Claude Desktop extensions  | [Local MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)                                                           | `exports/exportMcpb.ts` emits a manifest bundle                                   | Does not bundle arbitrary server code or dependencies                                             |
| Claude artifacts           | [Artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)                                                                           | No inspected direct publisher/exporter                                            | Potential demonstration surface, not an existing install target                                   |
| Claude Cowork/chat rollout | [Unified experience](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)                                                                     | Earlier prose treated surfaces as permanently separate                            | Capability-based routing is safer than assuming identical account rollout                         |
| Claude Code and automation | [Plugins](https://code.claude.com/docs/en/plugins), [Routines](https://code.claude.com/docs/en/routines)                                                                        | Native adapter/plugin support; no dedicated routine exporter                      | Local configurations work through existing engine; hosted automation requires another integration |

Built-in browsing, computer use, voice, images, and file tools belong to the host.
The [ChatGPT feature index](https://learn.chatgpt.com/docs/features) documents those
capabilities. AgentPack can supply guidance for a task that uses them; it does not
grant access or reproduce them in another product.

## Implementation decision

The strongest first deliverable was a route guide plus a skills-and-instructions
starter. Both cleared the local implementation floor (existing exporters and
actual authored content) and the external documentation floor (documented host
extension mechanisms). The starter avoids making a running MCP server, hosted
registry, or API credential a prerequisite.

Other feasible systems identified were workflow-specific starter packs, a richer
capability/loss report, and host-specific scheduling recipes. Connected workflows,
marketplace publishing, and account provisioning require separate integration
verification. These are architectural opportunities, not commitments or open-work
status; GitHub issues remain the tracker.

No research agent installed artifacts into a signed-in ChatGPT or Claude account.
Source documentation establishes a supported mechanism, not success on a particular
account. Local export tests and manual host acceptance are distinct evidence.
