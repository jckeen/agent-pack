import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentPackManifest, LoadedManifest } from "../schema/types.js";

const MANIFEST_FILENAME = "AGENTPACK.yaml";

export interface LoadManifestOptions {
  /** Path to a directory containing AGENTPACK.yaml, or directly to the yaml file. */
  cwd?: string;
}

/**
 * Resolve the manifest file path from a directory or explicit file path.
 * Throws when no manifest is reachable from the given input.
 */
export async function resolveManifestPath(target: string): Promise<string> {
  const abs = path.resolve(target);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch (err) {
    throw new Error(
      `Could not access path \`${abs}\`: ${(err as Error).message}`,
    );
  }
  if (stat.isFile()) return abs;
  const candidate = path.join(abs, MANIFEST_FILENAME);
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    throw new Error(
      `No \`${MANIFEST_FILENAME}\` found at \`${abs}\`. Pass a path to the manifest file or its directory.`,
    );
  }
}

/**
 * Load and YAML-parse an AGENTPACK manifest from disk. Does NOT validate — call
 * `validateManifest` next.
 */
export async function loadManifest(target: string): Promise<LoadedManifest> {
  const manifestPath = await resolveManifestPath(target);
  const packRoot = path.dirname(manifestPath);
  const rawYaml = await fs.readFile(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new Error(
      `Failed to parse YAML at \`${manifestPath}\`: ${(err as Error).message}`,
    );
  }
  return {
    manifest: parsed as AgentPackManifest,
    manifestPath,
    packRoot,
    rawYaml,
  };
}
