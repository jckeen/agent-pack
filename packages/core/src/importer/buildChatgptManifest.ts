// Maps a parsed ChatGPT-GPT bundle into an AgentPack manifest + atom files.
// No I/O — `importChatgptGptDir` (in ./importChatgptGpt.ts) handles the
// filesystem.
//
// Mapping (issue #41):
//   instructions          → instruction / rule atoms (reuses buildManifest's
//                           isRuleHeading governance split)
//   conversation_starters → appended "Suggested prompts" instruction atom
//   openapi.yaml          → mcp_server atom (connector recipe + transpiled tool
//                           catalogue) gated through permissions.mcp.servers
//   knowledge/*           → context_pack atom (copy) with a LOUD warning that
//                           managed RAG retrieval semantics won't reproduce
//
// The mcp_server atom is connector-shaped so `pack chat` emits a working
// connector recipe: transport=http, a url, an `auth: {scheme, scopes}` block,
// and `env` for any required secret. The transpiled tools are NOT runnable
// handlers — they are a catalogue a human uses to stand up the real remote MCP
// endpoint that fronts the API.

import { stringify } from "yaml";
import type {
  AgentPackManifest,
  Atom,
  PermissionsBlock,
  RiskLevel,
} from "../schema/types.js";
import { buildManifest, slugify, type ImportFile } from "./buildManifest.js";
import { importedCompatibility } from "./importCompatibility.js";
import type { ParseWarning } from "./parseClaudeMd.js";
import type { ParsedChatgptGpt } from "./parseChatgptGpt.js";

export interface BuildChatgptManifestOptions {
  /** `publisher.slug` — already validated by the caller. */
  id: string;
  name?: string;
  version?: string;
}

export interface BuildChatgptManifestResult {
  manifest: AgentPackManifest;
  files: ImportFile[];
  warnings: ParseWarning[];
}

/** Unique-slug allocator shared across every atom kind. */
function makeSlugAllocator() {
  const used = new Map<string, number>();
  return (base: string): string => {
    const seen = used.get(base);
    if (seen === undefined) {
      used.set(base, 1);
      return base;
    }
    const next = seen + 1;
    used.set(base, next);
    return `${base}-${next}`;
  };
}

const MAX_RISK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return MAX_RISK[a] >= MAX_RISK[b] ? a : b;
}

/** The loud, unmissable warning attached to every imported knowledge bundle. */
export const KNOWLEDGE_RAG_WARNING =
  "Knowledge files were copied verbatim into a context_pack atom, but ChatGPT's " +
  "managed vector-store RAG retrieval will NOT reproduce: a GPT silently retrieves " +
  "relevant chunks on every turn, whereas a context_pack is loaded wholesale (and " +
  "may exceed the context window) or surfaced inside a Project. For large or " +
  "frequently-queried knowledge, host it behind a real retrieval MCP server " +
  "instead of shipping raw files.";

export function buildChatgptManifest(
  parsed: ParsedChatgptGpt,
  opts: BuildChatgptManifestOptions,
): BuildChatgptManifestResult {
  const slug = opts.id.split(".").slice(1).join(".") || opts.id;
  const name = opts.name?.trim() || parsed.name?.trim() || slug;
  const version = opts.version?.trim() || "0.1.0";

  const files: ImportFile[] = [];
  const atoms: Atom[] = [];
  const warnings: ParseWarning[] = parsed.warnings.map((w) => ({
    line: 0,
    message: `${w.source}: ${w.message}`,
  }));
  const allocSlug = makeSlugAllocator();

  // ---------- instructions → instruction / rule atoms ----------
  if (parsed.parsedInstructions && parsed.parsedInstructions.sections.length > 0) {
    const base = buildManifest(parsed.parsedInstructions, { id: opts.id, name, version });
    for (const atom of base.manifest.atoms) {
      // Reserve the instruction slugs so synthesized atoms never collide.
      allocSlug(atom.id.split(":")[1] ?? atom.id);
      atoms.push(atom);
    }
    files.push(...base.files);
    warnings.push(...base.warnings);
  } else if (parsed.instructions && parsed.instructions.trim()) {
    // Instructions with no `## ` sections — emit a single instruction atom so
    // the prose isn't lost (buildManifest would throw on a section-less doc).
    const instrSlug = allocSlug("instructions");
    const relativePath = `atoms/instructions/${instrSlug}.md`;
    files.push({
      relativePath,
      content: `# ${name} instructions\n\n${parsed.instructions.trim()}\n`,
    });
    atoms.push({
      id: `instruction:${instrSlug}`,
      type: "instruction",
      name: `${name} instructions`,
      description: (parsed.description ?? `${name} instructions`).slice(0, 300),
      path: relativePath,
      risk_level: "low",
      permissions: [],
    });
  }

  // ---------- conversation_starters → "Suggested prompts" ----------
  if (parsed.conversationStarters.length > 0) {
    const promptsSlug = allocSlug("suggested-prompts");
    const relativePath = `atoms/instructions/${promptsSlug}.md`;
    const body = parsed.conversationStarters.map((s) => `- ${s}`).join("\n");
    files.push({
      relativePath,
      content: `# Suggested prompts\n\nConversation starters carried over from the ChatGPT GPT:\n\n${body}\n`,
    });
    atoms.push({
      id: `instruction:${promptsSlug}`,
      type: "instruction",
      name: "Suggested prompts",
      description: "Conversation starters carried over from the ChatGPT GPT.",
      path: relativePath,
      risk_level: "low",
      permissions: [],
    });
  }

  // ---------- openapi.yaml → mcp_server atom (connector recipe) ----------
  const mcpServerNames: string[] = [];
  const secretsRequired: NonNullable<NonNullable<PermissionsBlock["secrets"]>["required"]> =
    [];
  let hasOAuthConnector = false;
  if (parsed.action && parsed.action.tools.length > 0) {
    const action = parsed.action;
    const mcpSlug = allocSlug(slugify(action.title) || "action");
    const auth = action.auth;
    const envObj: Record<string, { required: boolean; description?: string }> = {};
    for (const secret of auth.secrets) {
      envObj[secret.name] = {
        required: true,
        ...(secret.description ? { description: secret.description } : {}),
      };
      secretsRequired.push({
        name: secret.name,
        ...(secret.description ? { description: secret.description } : {}),
        required_for: [`mcp_server:${mcpSlug}`],
      });
    }
    if (auth.scheme === "oauth2") hasOAuthConnector = true;

    // Atom-body YAML — read by `pack chat` for the connector recipe + tools.
    const atomBody: Record<string, unknown> = {
      id: mcpSlug,
      name: action.title,
      transport: "http",
      url: action.url ?? "https://REPLACE-ME.example.com",
      auth: { scheme: auth.scheme, scopes: auth.scopes },
      tools: action.tools.map((t) => ({
        name: t.name,
        description: t.description,
        method: t.method,
        path: t.path,
        inputSchema: t.inputSchema,
      })),
    };
    if (Object.keys(envObj).length > 0) atomBody.env = envObj;
    const relativePath = `atoms/mcp/${mcpSlug}.yaml`;
    files.push({ relativePath, content: stringify(atomBody, { lineWidth: 0 }) });
    mcpServerNames.push(mcpSlug);

    const permissions = ["network.access", "external_api.access"];
    if (Object.keys(envObj).length > 0) permissions.push("secrets.env");
    const mcpAtom: Record<string, unknown> = {
      id: `mcp_server:${mcpSlug}`,
      type: "mcp_server",
      name: action.title,
      description: `Remote MCP connector transpiled from the GPT Action \`${action.title}\` (${action.tools.length} tool(s)). SCAFFOLDING — stand up the real remote MCP endpoint and review auth scopes before wiring to claude.ai.`,
      path: relativePath,
      risk_level: "high",
      permissions,
      transport: "http",
      url: action.url ?? "https://REPLACE-ME.example.com",
    };
    if (Object.keys(envObj).length > 0) mcpAtom.env = envObj;
    atoms.push(mcpAtom as unknown as Atom);

    warnings.push({
      line: 0,
      message: `openapi: transpiled ${action.tools.length} operation(s) into MCP tool scaffolding (auth: ${auth.scheme}). Review auth scopes and stand up the real remote MCP server before using \`mcp_server:${mcpSlug}\`.`,
    });
    if (!action.url) {
      warnings.push({
        line: 0,
        message: `openapi: no \`servers[].url\` in the Action schema — set the connector \`url\` in atoms/mcp/${mcpSlug}.yaml by hand.`,
      });
    }
  }

  // ---------- knowledge/* → context_pack atom (with LOUD RAG warning) ----------
  if (parsed.knowledge.length > 0) {
    const kpSlug = allocSlug("knowledge");
    const dir = `atoms/context/${kpSlug}`;
    for (const f of parsed.knowledge) {
      files.push({ relativePath: `${dir}/${f.relPath}`, content: f.content });
    }
    atoms.push({
      id: `context_pack:${kpSlug}`,
      type: "context_pack",
      name: "Knowledge",
      description: `${parsed.knowledge.length} knowledge file(s) copied from the GPT. NOTE: managed RAG retrieval is NOT reproduced — see warnings.`,
      path: dir,
      risk_level: "low",
      permissions: [],
    } as Atom);
    warnings.push({ line: 0, message: `knowledge: ${KNOWLEDGE_RAG_WARNING}` });
  }

  if (atoms.length === 0) {
    throw new Error(
      "No ChatGPT-GPT artifacts found — nothing to import. Expected gpt.json with `instructions`/`conversation_starters`, an openapi.yaml Action schema, or a knowledge/ directory.",
    );
  }

  // ---------- permissions (declare what the atoms imply) ----------
  const permissions: PermissionsBlock = {};
  if (mcpServerNames.length > 0) {
    permissions.mcp = { servers: mcpServerNames };
    permissions.network = { access: "optional" };
    permissions.external_apis = mcpServerNames;
  }
  if (secretsRequired.length > 0) {
    permissions.secrets = { required: secretsRequired };
  }

  // ---------- overall risk ----------
  let riskLevel: RiskLevel = "low";
  for (const atom of atoms) riskLevel = maxRisk(riskLevel, atom.risk_level);

  const riskSummary = hasOAuthConnector
    ? "Imported from a ChatGPT GPT; includes an OAuth-gated MCP connector requiring scope review."
    : "Imported from a ChatGPT GPT.";

  const manifest: AgentPackManifest = {
    agentpack: "1.0",
    metadata: {
      id: opts.id,
      name,
      slug,
      description: parsed.description?.trim() || "Imported from a ChatGPT GPT",
      version,
      license: "MIT",
      publisher: opts.id.split(".")[0]!,
    },
    compatibility: { targets: importedCompatibility("chatgpt", "experimental") },
    permissions,
    security: { risk_level: riskLevel, risk_summary: riskSummary },
    profiles: {
      all: { description: "All imported atoms.", include: ["*"] },
    },
    atoms,
    exports: { default_profile: "all" },
  };

  return { manifest, files, warnings };
}
