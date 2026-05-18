---
name: code-review
description: Use this skill to review pull requests for correctness, maintainability, security, tests, and risk.
---

# Code Review Skill

Use this skill when asked to review a pull request, diff, branch, or code change.

## Review process

1. Identify the stated purpose of the change.
2. Inspect the actual changed files.
3. Compare implementation to intent.
4. Flag correctness risks.
5. Flag maintainability issues.
6. Flag security or privacy risks.
7. Check test coverage.
8. Summarize required changes separately from suggestions.

## Output format

Use this structure:

```md
## Summary

## Required Changes

## Security / Privacy Risks

## Test Coverage

## Suggestions

## Open Questions
```

## Standards

- Be specific.
- Cite filenames/functions when possible.
- Do not invent test results.
- Separate blocking issues from nice-to-have suggestions.
- When uncertain, say what needs to be verified.
