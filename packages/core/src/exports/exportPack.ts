import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AdapterOutputFile,
  InstallPlan,
  TargetPlatform,
} from "../schema/types.js";
import { getAdapter } from "../adapters/index.js";
import { loadManifest } from "../parser/loadManifest.js";
import { validateManifest } from "../validator/validateManifest.js";
import { createInstallPlan } from "../planner/createInstallPlan.js";

export interface ExportPackOptions {
  /** Path to the pack directory or AGENTPACK.yaml file. */
  source: string;
  target: TargetPlatform;
  profile?: string;
  outDir: string;
  /** When true, throw on validation errors before exporting. Default: true. */
  strict?: boolean;
  /** Only export these atom IDs (subset of resolved). */
  onlyAtoms?: string[];
}

export interface ExportResult {
  plan: InstallPlan;
  writtenFiles: string[];
  outDir: string;
}

/**
 * High-level export entry: loads → validates → plans → writes files to outDir.
 * Never writes outside outDir. Returns the InstallPlan plus a list of files
 * actually written to disk.
 */
export async function exportPack(options: ExportPackOptions): Promise<ExportResult> {
  const strict = options.strict ?? true;
  const loaded = await loadManifest(options.source);
  const validation = validateManifest(loaded.manifest);
  if (!validation.valid && strict) {
    const detail = validation.errors
      .map((e) => `[${e.code}] ${e.path}: ${e.message}`)
      .join("\n");
    throw new Error(`AgentPack manifest failed validation:\n${detail}`);
  }
  const adapter = getAdapter(options.target);
  const profile =
    options.profile ?? loaded.manifest.exports?.default_profile ?? "safe";
  const plan = await createInstallPlan({
    manifest: loaded.manifest,
    packRoot: loaded.packRoot,
    target: options.target,
    profile,
    adapter,
    onlyAtoms: options.onlyAtoms,
  });

  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const file of plan.files) {
    const absPath = path.resolve(outDir, file.path);
    if (!isInside(outDir, absPath)) {
      throw new Error(
        `Refusing to write file outside outDir: ${file.path} → ${absPath}`,
      );
    }
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, normalizeContent(file), "utf8");
    written.push(path.relative(outDir, absPath));
  }
  return { plan, writtenFiles: written, outDir };
}

function normalizeContent(file: AdapterOutputFile): string {
  // Ensure single trailing newline for determinism.
  return file.content.endsWith("\n") ? file.content : `${file.content}\n`;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
