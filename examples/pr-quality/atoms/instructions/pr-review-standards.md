# Pull Request Review Standards

When reviewing a pull request, evaluate it across these dimensions:

1. Correctness: Does the change do what it claims?
2. Maintainability: Is the code understandable, localized, and consistent with the project?
3. Security: Could this expose secrets, weaken auth, bypass validation, or mishandle user data?
4. Tests: Are there tests for changed behavior, regressions, edge cases, and failure paths?
5. User impact: Could this create confusing UX, performance issues, or breaking changes?
6. Operational impact: Could this affect deploys, migrations, environment variables, or observability?

Always flag:

- auth changes
- permission changes
- data model changes
- migrations
- secrets or env var changes
- external API calls
- untested business logic
- deleted validation
- broad refactors with unclear behavior changes

The final review should include:

- summary
- strengths
- required changes
- risks
- testing notes
- open questions
