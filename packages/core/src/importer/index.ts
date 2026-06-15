// `agentpack import` — compile an existing CLAUDE.md/AGENTS.md into an
// AgentPack. Public entry: `importClaudeMd` (pure) + `writeImport` (I/O).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringify } from "yaml";
import { parseClaudeMd } from "./parseClaudeMd.js";
import {
  buildManifest,
  type BuildManifestOptions,
  type ImportFile,
} from "./buildManifest.js";
import type { ParseWarning } from "./parseClaudeMd.js";
import type { AgentPackManifest } from "../schema/types.js";

export {
  parseClaudeMd,
  type ParsedClaudeMd,
  type ParsedSection,
  type ParseWarning,
} from "./parseClaudeMd.js";
export {
  buildManifest,
  slugify,
  type BuildManifestOptions,
  type BuildManifestResult,
  type ImportFile,
} from "./buildManifest.js";

export interface ImportResult {
  manifest: AgentPackManifest;
  /** All files to write, INCLUDING the manifest at `AGENTPACK.yaml`. */
  files: ImportFile[];
  warnings: ParseWarning[];
}

export type ImportOptions = BuildManifestOptions;

/**
 * Parse a CLAUDE.md/AGENTS.md and build the full set of files for an
 * AgentPack: the `AGENTPACK.yaml` manifest plus every atom file. Throws if the
 * source contains no `## ` sections (a pack needs ≥1 atom).
 */
export function importClaudeMd(text: string, opts: ImportOptions): ImportResult {
  const parsed = parseClaudeMd(text);
  const { manifest, files, warnings } = buildManifest(parsed, opts);

  // `agentpack: "1.0"` MUST serialize as a quoted string — an unquoted YAML
  // `1.0` parses back as a float and the schema (z.string) rejects it.
  const manifestYaml = stringify(manifest, { lineWidth: 0 });

  return {
    manifest,
    files: [{ relativePath: "AGENTPACK.yaml", content: manifestYaml }, ...files],
    warnings,
  };
}

/**
 * Write an import result to `outDir`. Rejects any file whose relative path
 * escapes the output directory (absolute, `..`, or leading separator).
 */
export async function writeImport(result: ImportResult, outDir: string): Promise<string[]> {
  const root = path.resolve(outDir);
  const written: string[] = [];
  for (const file of result.files) {
    const rel = file.relativePath;
    if (path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..") || /^[\\/]/.test(rel)) {
      throw new Error(`Refusing to write outside the output directory: ${rel}`);
    }
    const target = path.join(root, rel);
    // Defense in depth: confirm the resolved path is still inside root.
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Refusing to write outside the output directory: ${rel}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, "utf8");
    written.push(target);
  }
  return written;
}
