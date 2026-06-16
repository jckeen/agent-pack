import type { AtomType } from "./schema/types.js";

/**
 * Portability ceiling for each atom type: how far it can travel beyond the
 * terminal, across Claude's surfaces (claude.ai web, Desktop, Cowork,
 * Dispatch/mobile, the Agent SDK) and SKILL.md-compatible tools.
 *
 * This is an intrinsic property of the atom TYPE, not author-declared — like
 * risk, it's computed. It encodes the cross-surface research (June 2026):
 * Skills and MCP servers are account-level and reach every surface; commands,
 * subagents, and hooks ride inside a plugin on plugin-aware surfaces (Hooks are
 * a Cowork-supported plugin component); ambient instructions/rules have no home
 * outside Claude Code.
 *
 * Ceilings:
 *  - `universal`   — reaches every Claude surface (account-level GA).
 *  - `plugin`      — reaches plugin-aware surfaces (Code, Cowork, Desktop, the
 *                    web Directory) when shipped inside a plugin.
 *  - `sdk`         — only via the Agent SDK / Managed Agents runtime.
 *  - `terminal`    — Claude Code only; no ambient home on web/Desktop/Cowork.
 */
export type PortabilityCeiling = "universal" | "plugin" | "sdk" | "terminal";

export interface PortabilityInfo {
  ceiling: PortabilityCeiling;
  /** The official mechanism that carries this atom type the furthest. */
  mechanism: string;
  /** One-line, honest explanation of the ceiling. */
  note: string;
}

const PORTABILITY: Record<AtomType, PortabilityInfo> = {
  skill: {
    ceiling: "universal",
    mechanism: "SKILL.md (account-level Skills + open standard)",
    note: "Reaches Claude Code, claude.ai, Desktop, Cowork, the Agent SDK, and ~30 SKILL.md-compatible tools.",
  },
  mcp_server: {
    ceiling: "universal",
    mechanism: "remote MCP connector / .mcpb desktop bundle",
    note: "A remote connector is available on every Claude surface; .mcpb covers Desktop. Tools/resources/prompts only — not ambient instructions.",
  },
  command: {
    ceiling: "plugin",
    mechanism: "plugin slash command",
    note: "Slash commands ride inside a plugin on Code and Cowork; no home in plain claude.ai chat.",
  },
  subagent: {
    ceiling: "plugin",
    mechanism: "plugin agent",
    note: "Subagents ride inside a plugin on Code and Cowork; also constructible via the Agent SDK Tasks API.",
  },
  plugin: {
    ceiling: "plugin",
    mechanism: "Claude Code plugin / Directory",
    note: "A bundle of skills/agents/commands/hooks/MCP; installs on Code, Cowork, Desktop, and the web Directory.",
  },
  workflow: {
    ceiling: "sdk",
    mechanism: "Agent SDK / Managed Agents",
    note: "Workflows are a runtime construct — only reachable programmatically via the SDK or Managed Agents.",
  },
  hook: {
    ceiling: "plugin",
    mechanism: "plugin hooks (hooks/hooks.json)",
    note: "Lifecycle callbacks ride inside a plugin: Hooks are a Cowork-supported plugin component (claude.com/docs/cowork/3p/extensions), so they reach Code and Cowork. No home in plain claude.ai chat.",
  },
  instruction: {
    ceiling: "terminal",
    mechanism: "CLAUDE.md (Code) — bundle as a skill to reach further",
    note: "Ambient only in Claude Code. No CLAUDE.md loader on web/Cowork; bridge as an on-invoke skill, but it won't be ambient.",
  },
  rule: {
    ceiling: "terminal",
    mechanism: "CLAUDE.md (Code) — bundle as a skill to reach further",
    note: "Same ceiling as instructions: ambient only in Code; on-invoke at best elsewhere.",
  },
  context_pack: {
    ceiling: "terminal",
    mechanism: "Claude Code context folder",
    note: "A Claude Code convention for shared reference material; no equivalent surface elsewhere.",
  },
  template: {
    ceiling: "terminal",
    mechanism: "Claude Code template files",
    note: "File scaffolding specific to Claude Code workflows.",
  },
  eval: {
    ceiling: "terminal",
    mechanism: "Claude Code eval harness",
    note: "Agent evaluation harness specific to Claude Code.",
  },
};

const CEILING_RANK: Record<PortabilityCeiling, number> = {
  universal: 0,
  plugin: 1,
  sdk: 2,
  terminal: 3,
};

export function portabilityFor(type: AtomType): PortabilityInfo {
  return PORTABILITY[type];
}

/**
 * The portability summary for a set of atom types: the count per ceiling and
 * the overall "reach" — the *worst* ceiling present (i.e. how far the WHOLE
 * pack can travel as one unit is bounded by its least-portable atom).
 */
export interface PortabilitySummary {
  byCeiling: Record<PortabilityCeiling, AtomType[]>;
  /** The least-portable ceiling present, or "universal" if empty. */
  overall: PortabilityCeiling;
}

export function summarizePortability(types: readonly AtomType[]): PortabilitySummary {
  const byCeiling: Record<PortabilityCeiling, AtomType[]> = {
    universal: [],
    plugin: [],
    sdk: [],
    terminal: [],
  };
  for (const t of new Set(types)) {
    byCeiling[PORTABILITY[t].ceiling].push(t);
  }
  let overall: PortabilityCeiling = "universal";
  for (const t of types) {
    const c = PORTABILITY[t].ceiling;
    if (CEILING_RANK[c] > CEILING_RANK[overall]) overall = c;
  }
  return { byCeiling, overall };
}
