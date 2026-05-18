import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AdapterExportOptions,
  AdapterOutputFile,
  AdapterResult,
  AgentPackAdapter,
  Atom,
  ResolvedAtom,
  TargetPlatform,
} from "../schema/types.js";

export type { AgentPackAdapter, AdapterExportOptions, AdapterResult };

/**
 * Wrap content in the AgentPack BEGIN/END markers used by all instruction
 * outputs (CLAUDE.md, AGENTS.md, etc.). The packId is rendered in both
 * markers so multiple AgentPacks can coexist in one file.
 */
export function wrapInstructionBlock(packId: string, body: string): string {
  return `<!-- BEGIN AGENTPACK: ${packId} -->\n${body.trimEnd()}\n<!-- END AGENTPACK: ${packId} -->\n`;
}

/**
 * Read the contents of an atom's `path` field, resolved against the pack
 * root. Returns null on miss (adapters can decide to warn rather than fail).
 */
export async function readAtomFile(
  packRoot: string,
  atom: Atom,
): Promise<string | null> {
  const target = path.resolve(packRoot, atom.path);
  try {
    return await fs.readFile(target, "utf8");
  } catch {
    return null;
  }
}

/**
 * Recursively read a skill folder into a list of {relPath, content} entries.
 * Returns an empty list if the directory does not exist.
 */
export async function readAtomDirectory(
  packRoot: string,
  atom: Atom,
): Promise<Array<{ relPath: string; content: string }>> {
  const root = path.resolve(packRoot, atom.path);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(root);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) {
    const content = await fs.readFile(root, "utf8");
    return [{ relPath: path.basename(root), content }];
  }
  const results: Array<{ relPath: string; content: string }> = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, next);
      } else if (entry.isFile()) {
        const content = await fs.readFile(abs, "utf8");
        results.push({ relPath: next, content });
      }
    }
  }
  await walk(root, "");
  return results;
}

export function atomsByType(resolved: ResolvedAtom[]): Map<string, Atom[]> {
  const byType = new Map<string, Atom[]>();
  for (const r of resolved) {
    const list = byType.get(r.atom.type) ?? [];
    list.push(r.atom);
    byType.set(r.atom.type, list);
  }
  return byType;
}

export interface AdapterBaseInit {
  target: TargetPlatform;
  build(options: AdapterExportOptions): Promise<{
    files: AdapterOutputFile[];
    warnings: string[];
    unsupportedAtoms: string[];
  }>;
}

export function defineAdapter(init: AdapterBaseInit): AgentPackAdapter {
  return {
    target: init.target,
    async export(options) {
      const result = await init.build(options);
      // Sort files by path for deterministic output.
      const files = result.files
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path));
      return {
        target: init.target,
        files,
        warnings: result.warnings,
        unsupportedAtoms: result.unsupportedAtoms,
      };
    },
  };
}

export function stableJsonStringify(value: unknown): string {
  // Sort object keys recursively for deterministic JSON.
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = sortKeys(v);
    return out;
  }
  return value;
}
