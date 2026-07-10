// Static seed pack registry — used by the AgentPack Registry web app in MVP.
// Source of truth for seed-pack metadata. The structural shape mirrors
// `seed/seed-packs.json` at the repo root, but with TypeScript types and one
// fully populated example (PR-Quality) so the registry can render a real
// detail page without a database.

import type { CompatibilityStatus, RiskLevel, TargetPlatform } from "../schema/types.js";

export interface SeedPack {
  id: string;
  publisher: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  riskLevel: RiskLevel;
  tags: string[];
  platforms: Record<TargetPlatform, CompatibilityStatus>;
  /** Honest per-platform caveats shown in the compatibility matrix when the
   * seed has no manifest (a manifest's own compatibility notes win). */
  platformNotes?: Partial<Record<TargetPlatform, string>>;
  atomTypes: string[];
  /** Where the live AGENTPACK.yaml example lives in the monorepo, when available. */
  examplePath?: string;
  /** Whether this seed is wired to a real manifest in the repo. */
  hasExample?: boolean;
}

// "Supported" means the adapter emits complete output; runtime consumption
// still varies by platform (docs/adapters.md).
const CODEX_NOTE =
  "Compiled output; Codex consumes the repo-root AGENTS.md only — see the adapters doc.";
const CURSOR_NOTE =
  "Compiled output; skills inline into AGENTS.md and hooks have no stable Cursor target — see the adapters doc.";

export const SEED_PACKS: SeedPack[] = [
  {
    id: "agentpack.pr-quality",
    publisher: "agentpack",
    slug: "pr-quality",
    name: "Pull Request Quality Pack",
    version: "0.1.0",
    description:
      "Cross-platform PR review, security review, formatting, and summary workflow.",
    riskLevel: "high",
    tags: ["code-review", "pull-requests", "security"],
    platforms: {
      "claude-code": "supported",
      codex: "supported",
      cursor: "supported",
      chatgpt: "experimental",
      generic: "supported",
    },
    atomTypes: [
      "instruction",
      "rule",
      "skill",
      "command",
      "subagent",
      "hook",
      "mcp_server",
    ],
    examplePath: "examples/pr-quality",
    hasExample: true,
  },
  {
    id: "agentpack.claude-code-starter",
    publisher: "agentpack",
    slug: "claude-code-starter",
    name: "Claude Code Starter Pack",
    version: "0.1.0",
    description:
      "Starter project instructions, skills, hooks, and settings for Claude Code.",
    riskLevel: "high",
    tags: ["claude-code", "starter", "skills"],
    platforms: {
      "claude-code": "supported",
      codex: "partial",
      cursor: "partial",
      chatgpt: "unsupported",
      generic: "supported",
    },
    atomTypes: ["instruction", "skill", "hook", "rule", "template"],
  },
  {
    id: "agentpack.codex-agents-starter",
    publisher: "agentpack",
    slug: "codex-agents-starter",
    name: "Codex AGENTS.md Starter Pack",
    version: "0.1.0",
    description: "Starter AGENTS.md, Codex config, skills, and hooks.",
    riskLevel: "medium",
    tags: ["codex", "agents-md", "starter"],
    platforms: {
      "claude-code": "partial",
      codex: "supported",
      cursor: "partial",
      chatgpt: "unsupported",
      generic: "supported",
    },
    platformNotes: { codex: CODEX_NOTE },
    atomTypes: ["instruction", "skill", "rule", "template", "hook"],
  },
  {
    id: "agentpack.cursor-rules-starter",
    publisher: "agentpack",
    slug: "cursor-rules-starter",
    name: "Cursor Rules Starter Pack",
    version: "0.1.0",
    description: "Project rules, frontend/testing standards, and MCP config for Cursor.",
    riskLevel: "medium",
    tags: ["cursor", "rules", "mcp"],
    platforms: {
      "claude-code": "partial",
      codex: "partial",
      cursor: "supported",
      chatgpt: "unsupported",
      generic: "supported",
    },
    platformNotes: { cursor: CURSOR_NOTE },
    atomTypes: ["rule", "mcp_server", "template"],
  },
  {
    id: "agentpack.newsroom-editorial",
    publisher: "agentpack",
    slug: "newsroom-editorial",
    name: "Newsroom Editorial Workflow Pack",
    version: "0.1.0",
    description:
      "Editorial standards, fact-checking workflow, headline/social command, and human approval rules.",
    riskLevel: "medium",
    tags: ["newsroom", "editorial", "fact-checking"],
    platforms: {
      "claude-code": "supported",
      codex: "supported",
      cursor: "supported",
      chatgpt: "experimental",
      generic: "supported",
    },
    platformNotes: { codex: CODEX_NOTE, cursor: CURSOR_NOTE },
    atomTypes: ["instruction", "rule", "workflow", "command", "skill", "eval"],
  },
  {
    id: "agentpack.grant-research",
    publisher: "agentpack",
    slug: "grant-research",
    name: "Grant Research Workflow Pack",
    version: "0.1.0",
    description:
      "Prospect research, fit scoring, LOI drafting, budget narrative, and review checklist.",
    riskLevel: "medium",
    tags: ["fundraising", "grants", "research"],
    platforms: {
      "claude-code": "supported",
      codex: "supported",
      cursor: "supported",
      chatgpt: "experimental",
      generic: "supported",
    },
    platformNotes: { codex: CODEX_NOTE, cursor: CURSOR_NOTE },
    atomTypes: ["workflow", "skill", "command", "template", "eval"],
  },
  {
    id: "agentpack.hr-sensitive-comms",
    publisher: "agentpack",
    slug: "hr-sensitive-comms",
    name: "HR-Sensitive Communications Pack",
    version: "0.1.0",
    description:
      "Cautious tone, legal review flags, no-admissions rules, documentation discipline, and approval requirements.",
    riskLevel: "low",
    tags: ["hr", "legal-risk", "communications"],
    platforms: {
      "claude-code": "supported",
      codex: "supported",
      cursor: "supported",
      chatgpt: "partial",
      generic: "supported",
    },
    platformNotes: { codex: CODEX_NOTE, cursor: CURSOR_NOTE },
    atomTypes: ["instruction", "rule", "workflow", "command", "eval"],
  },
  {
    id: "agentpack.frontend-qa",
    publisher: "agentpack",
    slug: "frontend-qa",
    name: "Frontend QA Pack",
    version: "0.1.0",
    description:
      "Visual QA, accessibility checks, component review, responsive testing, and optional lint hook.",
    riskLevel: "high",
    tags: ["frontend", "qa", "accessibility"],
    platforms: {
      "claude-code": "supported",
      codex: "supported",
      cursor: "supported",
      chatgpt: "unsupported",
      generic: "supported",
    },
    platformNotes: { codex: CODEX_NOTE, cursor: CURSOR_NOTE },
    atomTypes: ["skill", "workflow", "command", "hook"],
  },
  {
    id: "agentpack.conference-followup",
    publisher: "agentpack",
    slug: "conference-followup",
    name: "Conference Follow-Up Pack",
    version: "0.1.0",
    description:
      "Contact capture, follow-up emails, note synthesis, and action plan generation.",
    riskLevel: "medium",
    tags: ["conference", "follow-up", "crm"],
    platforms: {
      "claude-code": "supported",
      codex: "supported",
      cursor: "supported",
      chatgpt: "partial",
      generic: "supported",
    },
    platformNotes: { codex: CODEX_NOTE, cursor: CURSOR_NOTE },
    atomTypes: ["workflow", "skill", "command", "template", "context_pack"],
  },
  {
    id: "agentpack.github-mcp-connector",
    publisher: "agentpack",
    slug: "github-mcp-connector",
    name: "MCP GitHub Connector Pack",
    version: "0.1.0",
    description:
      "GitHub MCP config, permission declarations, secret requirements, and install warnings.",
    riskLevel: "high",
    tags: ["mcp", "github", "connector"],
    platforms: {
      "claude-code": "supported",
      codex: "supported",
      cursor: "supported",
      chatgpt: "experimental",
      generic: "partial",
    },
    platformNotes: { codex: CODEX_NOTE, cursor: CURSOR_NOTE },
    atomTypes: ["mcp_server", "instruction", "rule", "template", "eval"],
  },
];

export function getSeedPackById(id: string): SeedPack | undefined {
  return SEED_PACKS.find((p) => p.id === id);
}

export function getSeedPack(publisher: string, slug: string): SeedPack | undefined {
  return SEED_PACKS.find((p) => p.publisher === publisher && p.slug === slug);
}

export function allTags(): string[] {
  const set = new Set<string>();
  for (const p of SEED_PACKS) for (const t of p.tags) set.add(t);
  return [...set].sort();
}
