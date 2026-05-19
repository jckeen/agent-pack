<!-- Thanks for the contribution! Please fill in the sections below. -->

## Summary

<!-- One or two sentences: what does this change and why. -->

## Why

<!-- Link the issue, or describe the motivation if there's no issue yet. -->

Closes #<!-- issue number, if applicable -->

## What changed

<!-- Bullet list of the meaningful changes. Skip cosmetic ones. -->

-
-

## Testing

<!-- How did you verify this works? Include commands you ran. -->

- [ ] `pnpm verify` (typecheck + lint + test + build) is green
- [ ] New tests cover the new behavior (or: change is doc/cleanup only)
- [ ] Manually exercised the affected CLI command / API route / UI page
- [ ] Smoke: `agentpack install examples/pr-quality --target claude-code --profile safe --project /tmp/pr-test --yes` still works

## Checklist

- [ ] Commits are signed and follow the existing message style
- [ ] No new dependencies without a one-line note explaining why
- [ ] CHANGELOG.md updated under the unreleased section (or noted as not user-visible)
- [ ] Docs updated if behavior, flags, or wire shapes changed
- [ ] If this touches a `Plans/` decision, the decision file is updated too
