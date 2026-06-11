import { parse as parseYaml } from "yaml";
import type { Atom } from "../schema/types.js";
import { readAtomFile } from "./types.js";

interface RuleBehavior {
  must?: string[];
  must_not?: string[];
}

interface RuleBody {
  severity?: string;
  scope?: { file_globs?: string[] };
  behavior?: RuleBehavior;
}

/**
 * Render a rule atom's substantive content as markdown. Rule bodies are YAML
 * files carrying the actual behavior contract (`behavior.must` /
 * `behavior.must_not`, severity, scope globs) — emitting only
 * `atom.description` silently drops the rule's entire effect (codex P0-3).
 *
 * Falls back to the description when the body is missing or unparseable, and
 * passes markdown bodies through verbatim.
 */
export async function renderRuleMarkdown(packRoot: string, atom: Atom): Promise<string> {
  const raw = await readAtomFile(packRoot, atom);
  if (!raw) return atom.description.trim();

  let parsed: RuleBody | null = null;
  try {
    const y = parseYaml(raw) as unknown;
    if (y && typeof y === "object" && !Array.isArray(y)) parsed = y as RuleBody;
  } catch {
    // Not YAML — treat the body as markdown/plain text and pass it through.
    return raw.trim();
  }
  if (!parsed) return raw.trim();

  const out: string[] = [atom.description.trim()];
  if (parsed.severity) out.push(`\nSeverity: **${parsed.severity}**`);
  const globs =
    parsed.scope?.file_globs ??
    (atom as { scope?: { file_globs?: string[] } }).scope?.file_globs;
  if (globs && globs.length > 0) {
    out.push(`\nApplies to:\n${globs.map((g) => `- \`${g}\``).join("\n")}`);
  }
  const must = parsed.behavior?.must ?? [];
  if (must.length > 0) {
    out.push(`\nMust:\n${must.map((m) => `- ${m}`).join("\n")}`);
  }
  const mustNot = parsed.behavior?.must_not ?? [];
  if (mustNot.length > 0) {
    out.push(`\nMust not:\n${mustNot.map((m) => `- ${m}`).join("\n")}`);
  }
  return out.join("\n");
}
