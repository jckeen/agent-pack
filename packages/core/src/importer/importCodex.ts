// `agentpack import --from codex` — I/O entry. Walks a Codex setup directory
// into a path→content map, then defers to the pure parse + build pipeline.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringify } from "yaml";
import { parseCodex } from "./parseCodex.js";
import {
  buildCodexManifest,
  type BuildCodexManifestOptions,
} from "./buildCodexManifest.js";
import type { ImportResult } from "./index.js";

export { parseCodex } from "./parseCodex.js";
export {
  buildCodexManifest,
  type BuildCodexManifestOptions,
  type BuildCodexManifestResult,
} from "./buildCodexManifest.js";
export type {
  ParsedCodex,
  CodexSkill,
  CodexMcpServer,
  CodexHook,
  CodexSubagent,
  CodexWarning,
} from "./parseCodex.js";

export type ImportCodexOptions = BuildCodexManifestOptions;

/** Files/dirs irrelevant to a Codex setup; skipped during the walk. */
const IGNORE = new Set([".git", "node_modules", ".DS_Store"]);
/** Cap the walk so a pathological tree can't exhaust memory. */
const MAX_FILES = 5000;
const MAX_BYTES = 5 * 1024 * 1024;

/** Recursively read a Codex dir into a forward-slash relative path map. */
async function readTree(root: string): Promise<Map<string, string>> {
  const realRoot = await fs.realpath(root);
  const tree = new Map<string, string>();
  let count = 0;

  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        // Refuse symlinks that escape the root (traversal defense).
        const target = await fs.realpath(abs).catch(() => null);
        if (!target || (target !== realRoot && !target.startsWith(realRoot + path.sep))) {
          continue;
        }
        const stat = await fs.stat(abs).catch(() => null);
        if (stat?.isDirectory()) {
          await walk(abs, rel);
          continue;
        }
        if (!stat?.isFile()) continue;
      } else if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      } else if (!entry.isFile()) {
        continue;
      }
      if (++count > MAX_FILES) {
        throw new Error(
          `Codex source has more than ${MAX_FILES} files; refusing to import.`,
        );
      }
      const stat = await fs.stat(abs);
      if (stat.size > MAX_BYTES) continue; // skip oversized blobs
      tree.set(rel, await fs.readFile(abs, "utf8"));
    }
  }

  await walk(realRoot, "");
  return tree;
}

/**
 * Import a Codex setup directory into a full AgentPack file set (manifest +
 * atom files). `rootDir` may be a project root containing `AGENTS.md` and
 * `.codex/`, or a `~/.codex` directory directly. The result mirrors
 * `importClaudeMd`: `files[0]` is the `AGENTPACK.yaml` manifest.
 */
export async function importCodexDir(
  rootDir: string,
  opts: ImportCodexOptions,
): Promise<ImportResult> {
  const tree = await readTree(rootDir);
  const parsed = parseCodex(tree);
  const { manifest, files, warnings } = buildCodexManifest(parsed, opts);
  const manifestYaml = stringify(manifest, { lineWidth: 0 });
  return {
    manifest,
    files: [{ relativePath: "AGENTPACK.yaml", content: manifestYaml }, ...files],
    warnings,
  };
}
