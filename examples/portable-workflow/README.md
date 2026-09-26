# Portable research and decisions

Use the same research-brief and decision-memo skills in ChatGPT and Claude.
The pack also includes shared Project instructions for clients where you prefer
copy-and-paste setup. It uses supplied material and requests no shell, network,
MCP server, or secret. Permission declarations describe the pack; they do not
replace the host application's permission controls.

[Build the CLI from source](../../README.md#quickstart-5-minutes), then run from
the repository root:

```bash
agentpack guide
agentpack guide chatgpt
agentpack guide chatgpt-project
agentpack guide claude
agentpack guide claude-plugin
```

Each route prints runnable export commands, expected artifacts, manual installation
steps, limitations, and official documentation. For your own pack, substitute its
path. `agentpack guide --json` exposes the same routes with command argument arrays.
See [ChatGPT and Claude onboarding](../../docs/chatgpt-claude.md) for the comparison.

## Try it

After installing the skills or pasting the Project instructions, start a new chat:

> Use research-brief to compare these workshop notes. Question: should we run a
> weekly or monthly workshop? Source A, participant survey: 12 of 20 respondents
> prefer monthly; the other 8 prefer weekly. Source B, facilitator notes: we can
> support one session per month with current staffing. Separate observations from
> inferences and identify missing evidence.

Then:

> Use decision-memo to recommend a workshop cadence using that brief. Our current
> staffing is fixed. Include a reversible next step and what could change the
> recommendation.

A useful result cites both supplied sources, does not treat the small survey as
proof about all participants, names staffing as a constraint, and proposes a
reviewable next step. Test missing evidence too: ask for a research brief without
supplying sources. It should request material or return a labeled research outline,
not invented findings. These are manual host acceptance checks, not a claim that
AgentPack controls the model's answer.

## What is shared

The native skills contain the detailed workflows. The separate instruction atom
provides a compact version for Project settings because the legacy `chatgpt`
adapter does not copy skill bodies into `project-instructions.md`. Editing one
workflow does not automatically update the other; keep their intent aligned.

Exports are local artifacts. They do not install into accounts, transfer chat
history or memory, publish a plugin, create schedules, or connect services.
