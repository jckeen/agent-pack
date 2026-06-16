// Pure parser for a human-assembled ChatGPT-GPT bundle. No I/O —
// `importChatgptGptDir` (in ./importChatgptGpt.ts) reads the filesystem and
// feeds a path→content map here.
//
// OpenAI offers NO GPT config export API (live June 2026), so a GPT import is
// fundamentally human-seeded: the user assembles a small bundle by hand from
// the GPT editor screen:
//
//   gpt.json     { name, description, instructions, conversation_starters[] }
//   openapi.yaml the GPT Action schema (optional; .json also accepted)
//   knowledge/*  copied knowledge files (optional)
//
// The tool dimension, by contrast, is clean: the Action schema transpiles into
// MCP tools (./openapiToMcp.ts), the shared spine across Apps SDK / Codex /
// Claude Connectors.

import { parseClaudeMd, type ParsedClaudeMd } from "./parseClaudeMd.js";
import { transpileOpenApiText, type TranspiledMcp } from "./openapiToMcp.js";

export interface ChatgptKnowledgeFile {
  /** Path relative to the `knowledge/` dir. */
  relPath: string;
  content: string;
}

export interface ChatgptWarning {
  /** Source file the warning is about. */
  source: string;
  message: string;
}

export interface ParsedChatgptGpt {
  name: string | null;
  description: string | null;
  /** Raw instructions text, or null when gpt.json omits it. */
  instructions: string | null;
  /** `instructions` parsed as a CLAUDE.md-style doc (sections → atoms). */
  parsedInstructions: ParsedClaudeMd | null;
  conversationStarters: string[];
  /** Transpiled Action schema, or null when the bundle ships no openapi file. */
  action: TranspiledMcp | null;
  knowledge: ChatgptKnowledgeFile[];
  warnings: ChatgptWarning[];
}

/** Normalize a tree key to forward-slash separators. */
function norm(p: string): string {
  return p.split(/[\\/]+/).join("/");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

/**
 * Parse a ChatGPT-GPT bundle (relative-path → file content) into structured
 * primitives. `gpt.json` is required and must contain at least `instructions`
 * or a `name`. An optional `openapi.yaml` / `openapi.json` is transpiled to MCP
 * tools; `knowledge/*` files are collected for a context_pack atom. Malformed
 * files surface as warnings, never throw.
 */
export function parseChatgptGpt(files: Map<string, string>): ParsedChatgptGpt {
  const tree = new Map<string, string>();
  for (const [k, v] of files) tree.set(norm(k), v);

  const warnings: ChatgptWarning[] = [];

  // ---------- gpt.json ----------
  const gptRaw = tree.get("gpt.json");
  let name: string | null = null;
  let description: string | null = null;
  let instructions: string | null = null;
  let conversationStarters: string[] = [];
  if (gptRaw === undefined) {
    warnings.push({
      source: "gpt.json",
      message:
        "No gpt.json found. A ChatGPT-GPT bundle must contain gpt.json with at least { name, instructions }.",
    });
  } else {
    try {
      const obj = JSON.parse(gptRaw) as Record<string, unknown>;
      if (typeof obj.name === "string" && obj.name.trim()) name = obj.name.trim();
      if (typeof obj.description === "string" && obj.description.trim()) {
        description = obj.description.trim();
      }
      if (typeof obj.instructions === "string" && obj.instructions.trim()) {
        instructions = obj.instructions;
      }
      // Accept both `conversation_starters` and `conversationStarters`.
      conversationStarters = asStringArray(
        obj.conversation_starters ?? obj.conversationStarters,
      );
    } catch (err) {
      warnings.push({
        source: "gpt.json",
        message: `Failed to parse gpt.json as JSON (${(err as Error).message}); skipped.`,
      });
    }
  }

  const parsedInstructions = instructions ? parseClaudeMd(instructions) : null;

  // ---------- openapi (Action schema) ----------
  const openapiPath = tree.has("openapi.yaml")
    ? "openapi.yaml"
    : tree.has("openapi.yml")
      ? "openapi.yml"
      : tree.has("openapi.json")
        ? "openapi.json"
        : null;
  let action: TranspiledMcp | null = null;
  if (openapiPath) {
    action = transpileOpenApiText(tree.get(openapiPath)!);
    for (const w of action.warnings) {
      warnings.push({ source: openapiPath, message: w });
    }
  }

  // ---------- knowledge/* ----------
  const knowledge: ChatgptKnowledgeFile[] = [];
  for (const [p, content] of tree) {
    const m = p.match(/^knowledge\/(.+)$/);
    if (!m) continue;
    knowledge.push({ relPath: m[1]!, content });
  }
  knowledge.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return {
    name,
    description,
    instructions,
    parsedInstructions,
    conversationStarters,
    action,
    knowledge,
    warnings,
  };
}
