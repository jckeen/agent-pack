# Seed Packs

The registry MVP should include these seed packs.

## 1. Pull Request Quality Pack

Purpose: Cross-platform PR review workflow.

Atoms:

- `instruction:pr-review-standards`
- `rule:security-review-required`
- `skill:code-review`
- `command:pr-summary`
- `subagent:security-reviewer`
- `hook:post-edit-format`
- `mcp_server:github`

Profiles:

- safe
- standard
- full
- enterprise

Risk:

- safe: low
- standard: medium
- full: high

## 2. Claude Code Starter Pack

Purpose: Starter configuration for Claude Code projects.

Atoms:

- `instruction:claude-project-defaults`
- `skill:repo-orientation`
- `skill:implementation-plan`
- `hook:format-after-edit`
- `rule:protect-env-files`
- `template:claude-md`

## 3. Codex AGENTS.md Starter Pack

Purpose: Starter Codex project setup.

Atoms:

- `instruction:agents-md-defaults`
- `skill:repo-orientation`
- `rule:test-before-final`
- `template:codex-config`
- `hook:stop-validation`

## 4. Cursor Rules Starter Pack

Purpose: Cursor rules and MCP starter pack.

Atoms:

- `rule:project-style`
- `rule:frontend-standards`
- `rule:testing-standards`
- `mcp_server:filesystem`
- `template:cursor-rules`

## 5. Newsroom Editorial Workflow Pack

Purpose: Human-reviewed editorial workflow for journalism teams.

Atoms:

- `instruction:editorial-standards`
- `rule:human-approval-required`
- `workflow:fact-checking`
- `command:headline-social`
- `skill:source-verification`
- `eval:no-fabricated-quotes`

## 6. Grant Research Workflow Pack

Purpose: Grant prospect research, fit scoring, LOI drafting, budget narrative support.

Atoms:

- `workflow:prospect-research`
- `skill:fit-scoring`
- `command:loi-draft`
- `template:budget-narrative`
- `eval:funding-fit-review`

## 7. HR-Sensitive Communications Pack

Purpose: Sensitive HR and legal-risk communications support.

Atoms:

- `instruction:cautious-hr-tone`
- `rule:no-admissions-of-liability`
- `rule:legal-review-flag`
- `workflow:documentation-discipline`
- `command:staff-message-review`
- `eval:flags-sensitive-claims`

Default profile: safe only.

## 8. Frontend QA Pack

Purpose: UI, accessibility, responsive, and component QA.

Atoms:

- `skill:visual-qa`
- `skill:accessibility-check`
- `workflow:responsive-testing`
- `command:component-review`
- `hook:run-lint-after-edit`

## 9. Conference Follow-Up Pack

Purpose: Post-event contact capture, note synthesis, email drafts, and action plans.

Atoms:

- `workflow:contact-capture`
- `skill:note-synthesis`
- `command:follow-up-email`
- `template:action-plan`
- `context_pack:event-context`

## 10. MCP GitHub Connector Pack

Purpose: GitHub MCP configuration with permissions and install warnings.

Atoms:

- `mcp_server:github`
- `instruction:github-tool-use`
- `rule:do-not-write-without-approval`
- `template:env-example`
- `eval:requires-token-warning`
