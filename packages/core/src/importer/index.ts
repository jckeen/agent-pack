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
export {
  importCodexDir,
  parseCodex,
  buildCodexManifest,
  type ImportCodexOptions,
  type BuildCodexManifestOptions,
  type BuildCodexManifestResult,
  type ParsedCodex,
  type CodexSkill,
  type CodexMcpServer,
  type CodexHook,
  type CodexSubagent,
  type CodexWarning,
} from "./importCodex.js";
export {
  importClaudeCodeDir,
  parseClaudeCode,
  buildClaudeCodeManifest,
  type ImportClaudeCodeOptions,
  type BuildClaudeCodeManifestOptions,
  type BuildClaudeCodeManifestResult,
  type ParsedClaudeCode,
  type ClaudeCodeSkill,
  type ClaudeCodeMcpServer,
  type ClaudeCodeHook,
  type ClaudeCodeSubagent,
  type ClaudeCodeCommand,
  type ClaudeCodeWarning,
} from "./importClaudeCode.js";
export {
  importChatgptGptDir,
  parseChatgptGpt,
  buildChatgptManifest,
  KNOWLEDGE_RAG_WARNING,
  openapiToMcp,
  transpileOpenApiText,
  toToolName,
  type ImportChatgptGptOptions,
  type BuildChatgptManifestOptions,
  type BuildChatgptManifestResult,
  type ParsedChatgptGpt,
  type ChatgptKnowledgeFile,
  type ChatgptWarning,
  type TranspiledMcp,
  type McpTool,
  type McpToolInputSchema,
  type McpAuth,
  type McpAuthScheme,
} from "./importChatgptGpt.js";

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
 * One file-level difference between a fresh import and an existing pack dir
 * (sync S3, `agentpack import --into`).
 */
export interface FoldChange {
  /** Pack-relative path (e.g. `atoms/skills/deploy/SKILL.md`). */
  path: string;
  kind: "added" | "changed" | "removed";
  /** On-disk content before the fold (absent for `added`). */
  before?: string;
  /** Content the fold writes (absent for `removed`). */
  after?: string;
}

/**
 * Fold a fresh import into an EXISTING pack directory (sync S3, #112):
 * `agentpack import --into`. The live config is the source for CONTENT —
 * atoms, permissions, security are regenerated — while the pack author's
 * packaging stays theirs: `metadata`, `compatibility`, `profiles`, `exports`,
 * and `adapters` are preserved verbatim from the existing manifest. Stale
 * files under `atoms/` (their live counterpart disappeared) are removed.
 *
 * With `apply: false` this is a pure preview — zero writes — so the CLI's
 * `--diff` can promise a mutation-free report. Review-then-commit stays the
 * consent point: git is the sync channel, this is the differ/compiler.
 */
export async function foldImportInto(params: {
  result: ImportResult;
  /** Parsed manifest of the existing pack (from `loadManifest(packDir)`). */
  existing: AgentPackManifest;
  packDir: string;
  apply: boolean;
}): Promise<{
  changes: FoldChange[];
  /**
   * Stale-atom deletions that failed on apply (#122). Never silently
   * swallowed: the pack still contains these files, so the caller must
   * surface them instead of reporting the fold as clean.
   */
  removalFailures: Array<{ path: string; error: string }>;
}> {
  const { result, existing, packDir } = params;
  const merged: AgentPackManifest = {
    ...result.manifest,
    metadata: existing.metadata,
    compatibility: existing.compatibility,
    profiles: existing.profiles,
    ...(existing.exports !== undefined ? { exports: existing.exports } : {}),
    ...(existing.adapters !== undefined ? { adapters: existing.adapters } : {}),
  };
  const mergedYaml = stringify(merged, { lineWidth: 0 });
  const files: ImportFile[] = result.files.map((f) =>
    f.relativePath === "AGENTPACK.yaml" ? { ...f, content: mergedYaml } : f,
  );

  const root = path.resolve(packDir);
  const changes: FoldChange[] = [];
  const generatedPaths = new Set(
    files.map((f) => f.relativePath.split(/[\\/]+/).join("/")),
  );

  for (const f of files) {
    const rel = f.relativePath;
    if (path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..") || /^[\\/]/.test(rel)) {
      throw new Error(`Refusing to touch a path outside the pack directory: ${rel}`);
    }
    const existingContent = await fs
      .readFile(path.join(root, rel), "utf8")
      .catch(() => null);
    if (existingContent === null) {
      changes.push({ path: rel, kind: "added", after: f.content });
    } else if (existingContent !== f.content) {
      changes.push({
        path: rel,
        kind: "changed",
        before: existingContent,
        after: f.content,
      });
    }
  }

  // Stale atom files: anything under atoms/ the fresh import no longer emits.
  // Confined to atoms/ so a pack repo's own files (README, .github/, tests)
  // are never candidates for deletion.
  const atomsDir = path.join(root, "atoms");
  const stale: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (!generatedPaths.has(rel)) stale.push(rel);
      }
    }
  }
  await walk(atomsDir);
  for (const rel of stale) {
    const before = await fs.readFile(path.join(root, rel), "utf8").catch(() => undefined);
    changes.push({
      path: rel,
      kind: "removed",
      ...(before !== undefined ? { before } : {}),
    });
  }

  const removalFailures: Array<{ path: string; error: string }> = [];
  if (params.apply && changes.length > 0) {
    const toWrite = changes
      .filter((c) => c.kind !== "removed")
      .map((c) => ({ relativePath: c.path, content: c.after ?? "" }));
    await writeImport({ ...result, files: toWrite }, root);
    for (const c of changes) {
      if (c.kind !== "removed") continue;
      try {
        await fs.unlink(path.join(root, c.path));
      } catch (err) {
        // A failed deletion means the pack STILL SHIPS the stale atom file —
        // collect it for the caller to surface (#122); silence here would
        // let import report success over a dirty pack.
        removalFailures.push({
          path: c.path,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      // Best-effort prune of now-empty dirs up to atoms/ (cosmetic only:
      // an empty dir left behind carries no content, unlike a failed unlink).
      let dir = path.dirname(path.join(root, c.path));
      while (dir.startsWith(atomsDir)) {
        try {
          await fs.rmdir(dir);
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
    }
  }
  return { changes, removalFailures };
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
