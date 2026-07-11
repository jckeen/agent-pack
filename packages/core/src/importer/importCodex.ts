// `agentpack import --from codex` — I/O entry. Walks a Codex setup directory
// into a path→content map, then defers to the pure parse + build pipeline.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isUtf8 } from "node:buffer";
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

function isCodexArtifactPath(rel: string, homeStyle: boolean): boolean {
  if (homeStyle) {
    return (
      rel === "AGENTS.md" ||
      rel === "config.toml" ||
      rel === "hooks.json" ||
      rel === "skills" ||
      rel === "agents" ||
      /^skills\//.test(rel) ||
      /^agents\/[^/]+\.toml$/.test(rel)
    );
  }
  return (
    rel === "AGENTS.md" ||
    rel === ".agents" ||
    rel === ".agents/skills" ||
    rel === ".codex" ||
    rel === ".codex/AGENTS.md" ||
    rel === ".codex/config.toml" ||
    rel === ".codex/hooks.json" ||
    rel === ".codex/skills" ||
    rel === ".codex/agents" ||
    /^(?:\.agents\/skills|\.codex\/skills)\//.test(rel) ||
    /^\.codex\/agents\/[^/]+\.toml$/.test(rel)
  );
}

function shouldTraverseCodexDirectory(rel: string, homeStyle: boolean): boolean {
  if (homeStyle) {
    return rel === "skills" || rel === "agents" || /^(?:skills|agents)\//.test(rel);
  }
  return (
    rel === ".agents" ||
    rel === ".agents/skills" ||
    rel.startsWith(".agents/skills/") ||
    rel === ".codex" ||
    rel.startsWith(".codex/")
  );
}

/** Recursively read a Codex dir into a forward-slash relative path map. */
async function readTree(
  root: string,
  options: { pathPrefix?: string; homeStyle?: boolean } = {},
): Promise<{
  tree: Map<string, string>;
  warnings: Array<{ source: string; message: string }>;
}> {
  const realRoot = await fs.realpath(root);
  const homeStyle = options.homeStyle ?? path.basename(realRoot) === ".codex";
  const pathPrefix = options.pathPrefix?.replace(/\/$/, "") ?? "";
  const tree = new Map<string, string>();
  const warnings: Array<{ source: string; message: string }> = [];
  let count = 0;

  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      const localRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const rel = pathPrefix ? `${pathPrefix}/${localRel}` : localRel;
      if (entry.isSymbolicLink()) {
        // Refuse symlinks that escape the root (traversal defense).
        const target = await fs.realpath(abs).catch(() => null);
        if (!target || (target !== realRoot && !target.startsWith(realRoot + path.sep))) {
          if (isCodexArtifactPath(rel, homeStyle)) {
            warnings.push({
              source: rel,
              message:
                "Symlinked Codex resource escapes the import root or is broken; skipped.",
            });
          }
          continue;
        }
        const stat = await fs.stat(abs).catch(() => null);
        if (stat?.isDirectory()) {
          if (shouldTraverseCodexDirectory(rel, homeStyle)) await walk(abs, localRel);
          continue;
        }
        if (!stat?.isFile()) continue;
      } else if (entry.isDirectory()) {
        if (shouldTraverseCodexDirectory(rel, homeStyle)) await walk(abs, localRel);
        continue;
      } else if (!entry.isFile()) {
        continue;
      }
      if (!isCodexArtifactPath(rel, homeStyle)) continue;
      if (++count > MAX_FILES) {
        throw new Error(
          `Codex source has more than ${MAX_FILES} files; refusing to import.`,
        );
      }
      const stat = await fs.stat(abs);
      if (stat.size > MAX_BYTES) {
        if (isCodexArtifactPath(rel, homeStyle)) {
          warnings.push({
            source: rel,
            message: `Oversized Codex resource skipped; files must be at most ${MAX_BYTES} bytes.`,
          });
        }
        continue;
      }
      const content = await fs.readFile(abs);
      if (!isUtf8(content)) {
        if (isCodexArtifactPath(rel, homeStyle)) {
          warnings.push({
            source: rel,
            message:
              "Non-UTF-8 Codex resource skipped; binary assets are not supported yet.",
          });
        }
        continue;
      }
      tree.set(rel, content.toString("utf8"));
    }
  }

  await walk(realRoot, "");
  return { tree, warnings };
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
  const resolvedRoot = await fs.realpath(rootDir);
  const { tree, warnings: readWarnings } = await readTree(resolvedRoot);
  if (path.basename(resolvedRoot) === ".codex") {
    const companionSkills = path.join(path.dirname(resolvedRoot), ".agents", "skills");
    const companionStat = await fs.lstat(companionSkills).catch(() => null);
    if (companionStat?.isSymbolicLink()) {
      readWarnings.push({
        source: ".agents/skills",
        message: "Symlinked companion Agent Skills root was skipped.",
      });
    } else if (companionStat?.isDirectory()) {
      const companion = await readTree(companionSkills, {
        pathPrefix: ".agents/skills",
        homeStyle: false,
      });
      for (const [rel, content] of companion.tree) tree.set(rel, content);
      readWarnings.push(...companion.warnings);
    }
  }
  const parsed = parseCodex(tree);
  parsed.warnings.unshift(...readWarnings);
  const { manifest, files, warnings } = buildCodexManifest(parsed, opts);
  const manifestYaml = stringify(manifest, { lineWidth: 0 });
  return {
    manifest,
    files: [{ relativePath: "AGENTPACK.yaml", content: manifestYaml }, ...files],
    warnings,
  };
}
