# Claude Code Start Here: Build AgentPack + AgentPack Registry

You are Claude Code operating as a founding engineer, product-minded infrastructure architect, and senior TypeScript/Next.js builder.

We are building a real product from scratch:

- **Standard:** AgentPack
- **Registry/Product:** AgentPack Registry
- **CLI:** `workgraph`
- **Package manifest:** `AGENTPACK.yaml`
- **Package units:** atoms
- **Platform compilers:** adapters

## Mission

Build the first working version of **AgentPack + AgentPack Registry**.

AgentPack is an open, atomic packaging standard for AI workflows, skills, hooks, plugins, rules, MCP tools, subagents, commands, context packs, templates, evals, and platform-specific agent customizations.

AgentPack Registry is the cross-platform registry, browser, validator, export system, and eventual installer for AgentPacks.

The product thesis:

> MCP is the tools/resources protocol. AGENTS.md is the generic instruction target. Agent Skills are the reusable capability format. Claude Code, Codex, Cursor, ChatGPT Apps, and other systems are host platforms. AgentPack is the missing packaging, validation, permissions, composition, installation, and registry layer above all of them.

Tagline:

> Write once. Install anywhere agents work.

## Required first step

Before coding, read every file in this packet:

- `README.md`
- `01_PRODUCT_SPEC.md`
- `02_AGENTPACK_STANDARD.md`
- `03_TECHNICAL_ARCHITECTURE.md`
- `04_SECURITY_MODEL.md`
- `05_ADAPTER_SPEC.md`
- `06_DATA_MODELS_AND_API.md`
- `07_SEED_PACKS.md`
- `08_ACCEPTANCE_CRITERIA.md`
- `09_IMPLEMENTATION_PHASES.md`
- `schemas/AGENTPACK.schema.json`
- `examples/pr-quality/AGENTPACK.yaml`
- all files under `examples/pr-quality/atoms/`
- `seed/seed-packs.json`

Then produce a brief implementation plan and start building.

## Product principle

Do **not** replace existing platform standards. Compile into them.

AgentPack must compile to:

- Claude Code: `CLAUDE.md`, `.claude/skills`, `.claude/settings.json`, `.claude/agents`
- Codex: `AGENTS.md`, `.codex/config.toml`, `.codex/hooks.json`, `.codex/skills`, `.codex/agents`
- Cursor: `.cursor/rules`, `.cursor/mcp.json`, `AGENTS.md`
- ChatGPT Apps SDK: export-only MCP app skeleton and `project-instructions.md`
- Generic: `AGENTS.md`, `skills/`, `README-agent.md`, `agentpack.json`

Where platform structures are not fully documented or are likely to change, mark the adapter output as conservative/proposed and make it easy to update.

## Build scope

Build a full ambitious local-first MVP, not just a demo.

Required outputs:

1. A TypeScript monorepo.
2. Shared AgentPack schema and validator.
3. Parser for `AGENTPACK.yaml`.
4. Permission summary engine.
5. Risk scoring engine.
6. Install/export planner.
7. Adapter exporters for:
   - Claude Code
   - Codex
   - Cursor
   - ChatGPT stub
   - Generic
8. CLI called `workgraph`.
9. Next.js registry web app.
10. Seed packs.
11. Example Pull Request Quality Pack.
12. Tests.
13. README and docs.
14. Clean UI.

## Tech stack

Use:

- pnpm workspace
- TypeScript
- Next.js App Router
- Tailwind CSS
- shadcn/ui style components or equivalent clean local components
- zod
- yaml
- commander
- picocolors
- ora
- diff
- vitest
- fs-extra or native fs/promises

Avoid unnecessary backend complexity in the first build. Use static seed data for the registry. Keep architecture ready for API/database later.

## Target monorepo structure

Create:

```text
.
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  README.md

  packages/
    core/
      package.json
      src/
        index.ts
        schema/
          agentpack.schema.ts
          types.ts
        parser/
          loadManifest.ts
        validator/
          validateManifest.ts
        permissions/
          summarizePermissions.ts
        risk/
          computeRisk.ts
        planner/
          createInstallPlan.ts
        adapters/
          types.ts
          claudeCode.ts
          codex.ts
          cursor.ts
          chatgpt.ts
          generic.ts
        exports/
          exportPack.ts
        seed/
          seedPacks.ts
      tests/
        manifest.test.ts
        risk.test.ts
        adapters.test.ts

    cli/
      package.json
      src/
        index.ts
        commands/
          init.ts
          validate.ts
          inspect.ts
          plan.ts
          export.ts
          doctor.ts

  apps/
    registry/
      package.json
      next.config.ts
      app/
        layout.tsx
        globals.css
        page.tsx
        packs/
          page.tsx
          [publisher]/
            [slug]/
              page.tsx
        validate/
          page.tsx
        docs/
          page.tsx
      components/
        PackCard.tsx
        RiskBadge.tsx
        CompatibilityMatrix.tsx
        PermissionSummary.tsx
        InstallCommandBox.tsx
        AtomList.tsx
        ManifestViewer.tsx
        Header.tsx
      lib/
        seed.ts
        manifest.ts

  examples/
    pr-quality/
      AGENTPACK.yaml
      README.md
      atoms/...

  docs/
    agentpack-standard.md
    security.md
    adapters.md
    cli.md
```

## CLI commands

Implement:

```bash
agentpack init
agentpack validate [path]
agentpack inspect [path]
agentpack plan [path] --target claude-code --profile safe
agentpack pack export [path] --target claude-code --out dist/claude
agentpack pack export [path] --target codex --out dist/codex
agentpack pack export [path] --target cursor --out dist/cursor
agentpack pack export [path] --target chatgpt --out dist/chatgpt
agentpack pack export [path] --target generic --out dist/generic
agentpack doctor
```

## Required behavior

- `validate` loads and validates `AGENTPACK.yaml`.
- `inspect` prints metadata, compatibility, profiles, atoms, permissions, and risk.
- `plan` resolves profile/atoms and prints generated file plan, risk, permissions, and warnings.
- `pack export` writes generated adapter files to `--out`.
- No actual filesystem install into user project is required yet, but the plan must be install-ready.

## Adapter behavior

Implement adapter outputs exactly as described in `05_ADAPTER_SPEC.md`.

## Web registry behavior

Build:

- `/` homepage
- `/packs` browser with filters
- `/packs/[publisher]/[slug]` detail page
- `/validate` manifest validator
- `/docs` docs overview

Use seed data from `seed/seed-packs.json` or equivalent TS seed file.

UI must show:

- pack title
- publisher
- version
- tags
- risk level
- compatibility matrix
- install command
- profiles
- atoms
- permission summary
- manifest preview

## Tests

Add vitest tests for:

- valid manifest parses
- duplicate atom IDs fail
- invalid profile atom references fail
- hook risk is high
- safe profile excludes hooks and MCP servers
- Claude adapter exports expected files
- Generic adapter exports expected files

## Acceptance criteria

The build is successful when:

1. `pnpm install` works.
2. `pnpm build` works.
3. `pnpm test` works.
4. `pnpm dev` starts the registry app.
5. `pnpm --filter @agentpack/cli build` works.
6. `agentpack validate examples/pr-quality` validates the example pack.
7. `agentpack inspect examples/pr-quality` prints the pack summary.
8. `agentpack plan examples/pr-quality --target claude-code --profile safe` prints a low-risk plan.
9. `agentpack plan examples/pr-quality --target claude-code --profile full` warns about hooks, shell execution, GitHub MCP, and `GITHUB_TOKEN`.
10. `agentpack pack export examples/pr-quality --target claude-code --out dist/claude` writes `CLAUDE.md` and `.claude/skills/code-review/SKILL.md`.
11. `agentpack pack export examples/pr-quality --target codex --out dist/codex` writes `AGENTS.md` and `.codex/config.toml`.
12. `agentpack pack export examples/pr-quality --target cursor --out dist/cursor` writes `AGENTS.md` and `.cursor/rules/security-review-required.mdc`.
13. `agentpack pack export examples/pr-quality --target generic --out dist/generic` writes `AGENTS.md`, `skills/code-review/SKILL.md`, and `agentpack.json`.
14. The web app renders the seed pack browser and detail pages.
15. The validate page validates pasted YAML.
16. README explains the standard, CLI, security model, adapters, and limitations.

## Quality bar

Be practical and precise. Do not fake unsupported integrations. Build clean seams so platform adapters can evolve. Treat agent packages like software supply chain artifacts. Permission summaries and risk warnings matter.

Start by reading the packet, then implement.
