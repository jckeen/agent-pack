> **Historical** — point-in-time record (2026-06-12). Do not act on this.

# Acceptance Criteria

The product is acceptable when all items below pass.

## Build

1. `pnpm install` works.
2. `pnpm build` works.
3. `pnpm test` works.
4. `pnpm dev` starts the registry app.
5. `pnpm --filter @agentpack/cli build` works.

## CLI

1. `agentpack validate examples/pr-quality` validates the example pack.
2. `agentpack inspect examples/pr-quality` prints:
   - name
   - version
   - publisher
   - compatibility
   - profiles
   - atoms
   - risk
   - permissions
3. `agentpack plan examples/pr-quality --target claude-code --profile safe` prints:
   - selected atoms
   - low risk
   - permissions
   - generated files
4. `agentpack plan examples/pr-quality --target claude-code --profile full` warns about:
   - shell execution
   - hook
   - GitHub MCP
   - `GITHUB_TOKEN`
5. `agentpack pack export examples/pr-quality --target claude-code --out dist/claude` writes:
   - `dist/claude/CLAUDE.md`
   - `dist/claude/.claude/skills/code-review/SKILL.md`
   - `dist/claude/.claude/agents/security-reviewer.md` for standard/full profile
6. `agentpack pack export examples/pr-quality --target codex --out dist/codex` writes:
   - `dist/codex/AGENTS.md`
   - `dist/codex/.codex/config.toml`
   - `dist/codex/.codex/skills/code-review/SKILL.md`
7. `agentpack pack export examples/pr-quality --target cursor --out dist/cursor` writes:
   - `dist/cursor/AGENTS.md`
   - `dist/cursor/.cursor/rules/security-review-required.mdc`
8. `agentpack pack export examples/pr-quality --target generic --out dist/generic` writes:
   - `dist/generic/AGENTS.md`
   - `dist/generic/skills/code-review/SKILL.md`
   - `dist/generic/agentpack.json`

## Web app

1. Homepage communicates product clearly.
2. Pack browser lists all seed packs.
3. Filters work client-side.
4. Pack detail pages render.
5. Compatibility matrix renders.
6. Permission summary renders.
7. Install command box renders.
8. Atom list renders.
9. Validate page validates pasted YAML.
10. Docs page explains AgentPack, CLI, adapters, and security.

## Tests

Add tests for:

1. Valid manifest parses.
2. Duplicate atom IDs fail.
3. Invalid profile atom references fail.
4. Hook risk is high.
5. Safe profile excludes hooks and MCP servers.
6. Claude adapter exports expected files.
7. Codex adapter exports expected files.
8. Cursor adapter exports expected files.
9. Generic adapter exports expected files.

## Quality bar

- No fake platform claims.
- No silent permission escalation.
- Deterministic adapter output.
- Clear warnings for dangerous atoms.
- Clean TypeScript types.
- Modular code.
- Professional README.
- Serious infrastructure-product UI.
