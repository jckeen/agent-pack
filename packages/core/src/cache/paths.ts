/**
 * Resolve the canonical `~/.agentpack/cache/...` paths.
 *
 * Honors `process.env.AGENTPACK_HOME` (legacy: `WORKGRAPH_HOME`) as an override for testing — when set,
 * the cache root is `<AGENTPACK_HOME>/cache/` instead of `$HOME/.agentpack/cache/`.
 */

import path from "node:path";
import os from "node:os";

export interface CachePaths {
  /** AgentPack home directory — `~/.agentpack` by default. */
  home: string;
  /** Cache root — `<home>/cache`. */
  root: string;
  /** Content-addressed blobs — `<root>/blobs`. */
  blobs: string;
  /** Raw manifest cache — `<root>/manifests`. */
  manifests: string;
  /** Symlink/copy view by pack — `<root>/packs`. */
  packs: string;
}

export function getAgentpackHome(): string {
  return process.env.AGENTPACK_HOME ?? process.env.WORKGRAPH_HOME ?? path.join(os.homedir(), ".agentpack");
}

export function getCachePaths(home?: string): CachePaths {
  const resolvedHome = home ?? getAgentpackHome();
  const root = path.join(resolvedHome, "cache");
  return {
    home: resolvedHome,
    root,
    blobs: path.join(root, "blobs"),
    manifests: path.join(root, "manifests"),
    packs: path.join(root, "packs"),
  };
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function getBlobPath(sha256: string, paths?: CachePaths): string {
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`getBlobPath: invalid sha256 (must be lowercase 64-hex): ${sha256}`);
  }
  const p = paths ?? getCachePaths();
  const prefix = sha256.slice(0, 2);
  return path.join(p.blobs, prefix, sha256);
}
