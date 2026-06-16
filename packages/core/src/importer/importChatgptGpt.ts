// `agentpack import --from chatgpt-gpt` — I/O entry. Walks a human-assembled
// ChatGPT-GPT bundle directory into a path→content map, then defers to the pure
// parse + build pipeline.
//
// File reads use the symlink-safe `readPackRelativeFile` boundary (CWE-59): the
// bundle is untrusted input, so a symlink at any bundle path must not redirect a
// read to a file outside the bundle root.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringify } from "yaml";
import { readPackRelativeFile } from "../adapters/types.js";
import { parseChatgptGpt } from "./parseChatgptGpt.js";
import {
  buildChatgptManifest,
  type BuildChatgptManifestOptions,
} from "./buildChatgptManifest.js";
import type { ImportResult } from "./index.js";

export { parseChatgptGpt } from "./parseChatgptGpt.js";
export {
  buildChatgptManifest,
  KNOWLEDGE_RAG_WARNING,
  type BuildChatgptManifestOptions,
  type BuildChatgptManifestResult,
} from "./buildChatgptManifest.js";
export type {
  ParsedChatgptGpt,
  ChatgptKnowledgeFile,
  ChatgptWarning,
} from "./parseChatgptGpt.js";
export {
  openapiToMcp,
  transpileOpenApiText,
  toToolName,
  type TranspiledMcp,
  type McpTool,
  type McpToolInputSchema,
  type McpAuth,
  type McpAuthScheme,
} from "./openapiToMcp.js";

export type ImportChatgptGptOptions = BuildChatgptManifestOptions;

/** Files/dirs irrelevant to a GPT bundle; skipped during the walk. */
const IGNORE = new Set([".git", "node_modules", ".DS_Store"]);
/** Cap the walk so a pathological tree can't exhaust memory. */
const MAX_FILES = 5000;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Recursively read a bundle dir into a forward-slash relative path map, using
 * the symlink-safe pack-relative reader for every file. `realRoot` is the
 * realpath of the bundle root; a symlinked subdir that escapes it is skipped.
 */
async function readTree(root: string): Promise<Map<string, string>> {
  const realRoot = await fs.realpath(root);
  const tree = new Map<string, string>();
  let count = 0;

  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      // Symlinks and non-regular files are rejected by readPackRelativeFile.
      if (++count > MAX_FILES) {
        throw new Error(
          `ChatGPT-GPT bundle has more than ${MAX_FILES} files; refusing to import.`,
        );
      }
      const lstat = await fs.lstat(abs).catch(() => null);
      if (!lstat || lstat.isSymbolicLink() || !lstat.isFile()) continue;
      if (lstat.size > MAX_BYTES) continue; // skip oversized blobs
      const content = await readPackRelativeFile(realRoot, rel);
      if (content !== null) tree.set(rel, content);
    }
  }

  await walk(realRoot, "");
  return tree;
}

/**
 * Import a ChatGPT-GPT bundle directory into a full AgentPack file set
 * (manifest + atom files). `rootDir` contains `gpt.json` and optionally
 * `openapi.yaml` and a `knowledge/` directory. The result mirrors
 * `importClaudeMd`: `files[0]` is the `AGENTPACK.yaml` manifest.
 */
export async function importChatgptGptDir(
  rootDir: string,
  opts: ImportChatgptGptOptions,
): Promise<ImportResult> {
  const tree = await readTree(rootDir);
  const parsed = parseChatgptGpt(tree);
  const { manifest, files, warnings } = buildChatgptManifest(parsed, opts);
  const manifestYaml = stringify(manifest, { lineWidth: 0 });
  return {
    manifest,
    files: [{ relativePath: "AGENTPACK.yaml", content: manifestYaml }, ...files],
    warnings,
  };
}
