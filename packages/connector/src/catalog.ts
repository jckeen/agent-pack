import {
  loadManifest,
  readAtomDirectory,
  readAtomFile,
  type AgentPackManifest,
  type Atom,
  type AtomType,
} from "@agentpack/core";

/**
 * A pack's guidance, reshaped for MCP. Skills/commands/instructions/rules/
 * subagents become **prompts** (invokable, slash-command-like on every surface)
 * and **resources** (readable content). This is the portable subset — what a
 * remote MCP connector can carry to claude.ai, Desktop, Cowork, and mobile.
 *
 * Deliberately excluded: `hook` (no MCP equivalent — host-side event loop) and
 * `mcp_server` (already its own MCP server; the connector doesn't re-wrap it).
 * MCP also can't make any of this *ambient* the way CLAUDE.md is in Claude
 * Code — prompts are invoked, not auto-loaded.
 */
export interface ConnectorCatalog {
  packId: string;
  packSlug: string;
  packName: string;
  packVersion: string;
  prompts: ConnectorPrompt[];
  resources: ConnectorResource[];
  /** Atom types present in the pack that the connector cannot carry. */
  excluded: { type: AtomType; reason: string }[];
}

export interface ConnectorPrompt {
  name: string;
  title: string;
  description: string;
  body: string;
  atomType: AtomType;
}

export interface ConnectorResource {
  uri: string;
  name: string;
  mimeType: string;
  body: string;
}

const CARRIED: ReadonlySet<AtomType> = new Set<AtomType>([
  "skill",
  "command",
  "instruction",
  "rule",
  "subagent",
]);

const EXCLUDED_REASON: Partial<Record<AtomType, string>> = {
  hook: "Hooks are a Claude Code event-loop construct with no MCP equivalent.",
  mcp_server: "MCP servers are already their own connector; not re-wrapped by this one.",
  plugin: "Plugins are a Claude Code bundling construct, not an MCP primitive.",
  workflow: "Workflows are an Agent SDK / Managed Agents runtime construct.",
  context_pack: "Context packs are Claude Code-only.",
  template: "Templates are Claude Code-only.",
  eval: "Evals are Claude Code-only.",
};

/** Strip the `type:` prefix from an atom id → a slug usable as an MCP name. */
export function atomSlug(id: string): string {
  const idx = id.indexOf(":");
  const tail = idx === -1 ? id : id.slice(idx + 1);
  return tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Build the connector catalog for a pack at `source` (dir or AGENTPACK.yaml). */
export async function loadPackCatalog(source: string): Promise<ConnectorCatalog> {
  const { manifest, packRoot } = await loadManifest(source);
  return buildCatalog(manifest, packRoot);
}

export async function buildCatalog(
  manifest: AgentPackManifest,
  packRoot: string,
): Promise<ConnectorCatalog> {
  const packSlug = manifest.metadata.slug;
  const prompts: ConnectorPrompt[] = [];
  const resources: ConnectorResource[] = [];
  const excludedTypes = new Set<AtomType>();

  for (const atom of manifest.atoms) {
    if (!CARRIED.has(atom.type)) {
      excludedTypes.add(atom.type);
      continue;
    }
    const slug = atomSlug(atom.id);
    if (atom.type === "skill") {
      const files = await readAtomDirectory(packRoot, atom);
      const skillDoc = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.relPath)) ?? files[0];
      const body = skillDoc?.content ?? "";
      prompts.push(makePrompt(atom, slug, body));
      for (const f of files) {
        resources.push({
          uri: `agentpack://${packSlug}/skills/${slug}/${f.relPath}`,
          name: `${atom.name ?? slug} — ${f.relPath}`,
          mimeType: mimeFor(f.relPath),
          body: f.content,
        });
      }
      continue;
    }
    const body = (await readAtomFile(packRoot, atom)) ?? "";
    prompts.push(makePrompt(atom, slug, body));
    resources.push({
      uri: `agentpack://${packSlug}/${atom.type}/${slug}`,
      name: atom.name ?? slug,
      mimeType: "text/markdown",
      body,
    });
  }

  return {
    packId: manifest.metadata.id,
    packSlug,
    packName: manifest.metadata.name,
    packVersion: manifest.metadata.version,
    prompts,
    resources,
    excluded: [...excludedTypes].map((type) => ({
      type,
      reason: EXCLUDED_REASON[type] ?? "Not representable as an MCP primitive.",
    })),
  };
}

function makePrompt(atom: Atom, slug: string, body: string): ConnectorPrompt {
  return {
    name: slug,
    title: atom.name ?? slug,
    description: atom.description || `${atom.type} ${slug} from the pack`,
    body,
    atomType: atom.type,
  };
}

function mimeFor(relPath: string): string {
  if (/\.md$/i.test(relPath)) return "text/markdown";
  if (/\.json$/i.test(relPath)) return "application/json";
  if (/\.(ya?ml)$/i.test(relPath)) return "text/yaml";
  return "text/plain";
}
