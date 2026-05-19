/**
 * Resolve the canonical `~/.workgraph/cache/...` paths.
 *
 * Honors `process.env.WORKGRAPH_HOME` as an override for testing — when set,
 * the cache root is `<WORKGRAPH_HOME>/cache/` instead of `$HOME/.workgraph/cache/`.
 */

import path from "node:path";
import os from "node:os";

export interface CachePaths {
  /** Workgraph home directory — `~/.workgraph` by default. */
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

export function getWorkgraphHome(): string {
  return process.env.WORKGRAPH_HOME ?? path.join(os.homedir(), ".workgraph");
}

export function getCachePaths(home?: string): CachePaths {
  const resolvedHome = home ?? getWorkgraphHome();
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
