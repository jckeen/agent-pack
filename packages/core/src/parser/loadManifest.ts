import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentPackManifest, LoadedManifest } from "../schema/types.js";

const MANIFEST_FILENAME = "AGENTPACK.yaml";

/**
 * Hard cap on manifest size — defends against accidental or adversarial
 * pasting of huge documents into the parser (registry `/validate` page or
 * a malicious pack on disk). 1 MiB is more than enough for any reasonable
 * manifest: the bundled PR-Quality example is ~6 KiB.
 */
export const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;

export class ManifestTooLargeError extends Error {
  constructor(public readonly actualBytes: number) {
    super(
      `AGENTPACK.yaml is ${actualBytes} bytes — exceeds the ${MAX_MANIFEST_BYTES}-byte limit.`,
    );
    this.name = "ManifestTooLargeError";
  }
}

export interface LoadManifestOptions {
  /** Maximum bytes to read from the manifest file. Defaults to `MAX_MANIFEST_BYTES`. */
  maxBytes?: number;
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
 * Load and YAML-parse an AGENTPACK manifest from disk. Does NOT validate the
 * structural content — call `validateManifest` next.
 *
 * Hardening:
 *  - File size capped at `MAX_MANIFEST_BYTES` (default 1 MiB).
 *  - YAML parse uses the `yaml` package's safe default (no exotic tags, no
 *    JS function evaluation, no prototype writes).
 *  - YAML parse errors are wrapped with the manifest path for clarity.
 */
export async function loadManifest(
  target: string,
  options: LoadManifestOptions = {},
): Promise<LoadedManifest> {
  const manifestPath = await resolveManifestPath(target);
  const packRoot = path.dirname(manifestPath);
  const maxBytes = options.maxBytes ?? MAX_MANIFEST_BYTES;
  const stat = await fs.stat(manifestPath);
  if (stat.size > maxBytes) {
    throw new ManifestTooLargeError(stat.size);
  }
  const rawYaml = await fs.readFile(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml, {
      // yaml@2 defaults are safe — no merge keys, no anchor explosion, no
      // arbitrary tag resolution — but we lock the relevant knobs explicitly
      // so future yaml releases that change defaults don't widen the surface.
      prettyErrors: true,
      strict: false,
    });
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

/**
 * Parse a raw YAML string (e.g. from a registry paste-box). Same size guard
 * and safe defaults as `loadManifest`, but no file-system access.
 */
export function parseManifestYaml(
  yaml: string,
  options: LoadManifestOptions = {},
): unknown {
  const maxBytes = options.maxBytes ?? MAX_MANIFEST_BYTES;
  const byteLength = Buffer.byteLength(yaml, "utf8");
  if (byteLength > maxBytes) throw new ManifestTooLargeError(byteLength);
  return parseYaml(yaml, { prettyErrors: true, strict: false });
}
