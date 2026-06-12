> **Historical** — point-in-time record (2026-06-12). Do not act on this.

# Technical Architecture

## System overview

The product has four main layers:

1. **AgentPack Core** — schema, parser, validator, permissions, risk, planner, adapters.
2. **workgraph CLI** — local validation, inspection, planning, export, later install/uninstall.
3. **AgentPack Registry Web App** — browser, detail pages, validation, copy install commands.
4. **Registry API** — future publish/search/export/review endpoints.

## MVP architecture

Use a TypeScript monorepo.

```text
packages/core
packages/cli
apps/registry
examples/pr-quality
docs
```

## Core package

Responsibilities:

- Load `AGENTPACK.yaml`.
- Validate manifest.
- Resolve profiles.
- Resolve selected atoms.
- Compute permissions.
- Compute risk.
- Generate install/export plans.
- Compile adapter outputs.

Important functions:

```ts
loadManifest(path: string): Promise<AgentPackManifest>
validateManifest(input: unknown): ValidationResult
resolveAtoms(manifest, profile, onlyAtoms): ResolvedAtom[]
summarizePermissions(manifest, atoms): PermissionSummary
computeRisk(manifest, atoms): RiskSummary
createInstallPlan(options): InstallPlan
exportPack(options): Promise<ExportResult>
```

## CLI package

Command framework: Commander.

Commands:

```bash
agentpack init
agentpack validate [path]
agentpack inspect [path]
agentpack plan [path] --target <target> --profile <profile>
agentpack pack export [path] --target <target> --out <dir>
agentpack doctor
```

## Registry app

Use Next.js App Router.

Routes:

```text
/
/packs
/packs/[publisher]/[slug]
/validate
/docs
```

Registry uses seed data in MVP.

Later, replace seed layer with API/database.

## Adapter interface

```ts
export type TargetPlatform =
  | "claude-code"
  | "codex"
  | "cursor"
  | "chatgpt"
  | "generic";

export type AdapterOutputFile = {
  path: string;
  content: string;
  action: "create" | "modify";
  notes?: string[];
};

export type AdapterResult = {
  target: TargetPlatform;
  files: AdapterOutputFile[];
  warnings: string[];
  unsupportedAtoms: string[];
};

export interface AgentPackAdapter {
  target: TargetPlatform;
  export(options: AdapterExportOptions): Promise<AdapterResult>;
}
```

## Install planner

MVP only plans and exports. Full install later.

Install plan fields:

```ts
type InstallPlan = {
  packId: string;
  packVersion: string;
  target: TargetPlatform;
  profile: string;
  atoms: string[];
  riskLevel: RiskLevel;
  permissions: PermissionSummary;
  warnings: string[];
  files: AdapterOutputFile[];
};
```

## Export flow

```text
1. Load manifest.
2. Validate.
3. Resolve target.
4. Resolve profile.
5. Resolve atom subset.
6. Compute risk and permissions.
7. Run adapter exporter.
8. Write files to output directory.
9. Print summary.
```

## Future install flow

```text
1. Plan.
2. Diff against project root.
3. Show permission summary.
4. Confirm.
5. Backup modified files.
6. Write generated files.
7. Write uninstall manifest.
8. Write lockfile.
```

## Monorepo package names

- `@agentpack/core`
- `@agentpack/cli`
- `@agentpack/registry`

## Development scripts

Root scripts:

```json
{
  "dev": "pnpm --filter @agentpack/registry dev",
  "build": "pnpm -r build",
  "test": "pnpm -r test",
  "lint": "pnpm -r lint"
}
```
