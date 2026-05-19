/**
 * Content-addressed blob store under `~/.workgraph/cache/blobs/<sha[0..2]>/<sha>`.
 *
 * Every write verifies sha256(bytes) === expected before promoting the temp
 * file. Every fetch from the registry runs through `fetchAndCache`, which is
 * the integrity-check chokepoint for remote-install (Phase 5).
 */

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { BlobNotFoundError, IntegrityError } from "./errors.js";
import { getBlobPath, type CachePaths } from "./paths.js";

export async function hasBlob(sha256: string, paths?: CachePaths): Promise<boolean> {
  const blobPath = getBlobPath(sha256, paths);
  try {
    await fs.access(blobPath);
    return true;
  } catch {
    return false;
  }
}

export async function readBlob(
  sha256: string,
  paths?: CachePaths
): Promise<Buffer> {
  const blobPath = getBlobPath(sha256, paths);
  try {
    return await fs.readFile(blobPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BlobNotFoundError(sha256);
    }
    throw err;
  }
}

export async function writeBlob(
  sha256: string,
  bytes: Buffer,
  paths?: CachePaths
): Promise<void> {
  const actual = sha256OfBuffer(bytes);
  if (actual !== sha256) {
    throw new IntegrityError(sha256, actual);
  }
  const blobPath = getBlobPath(sha256, paths);
  const blobDir = path.dirname(blobPath);
  await fs.mkdir(blobDir, { recursive: true });

  // Atomic write: temp file in the same dir, fsync, rename.
  const tmpName = `${sha256}.${randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = path.join(blobDir, tmpName);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmpPath, "wx", 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmpPath, blobPath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore — best effort cleanup */
    }
    throw err;
  }
}

export interface FetchAndCacheOptions {
  paths?: CachePaths;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export async function fetchAndCache(
  url: string,
  expectedSha256: string,
  opts: FetchAndCacheOptions = {}
): Promise<Buffer> {
  if (await hasBlob(expectedSha256, opts.paths)) {
    return readBlob(expectedSha256, opts.paths);
  }
  const f = opts.fetchImpl ?? globalThis.fetch;
  const res = await f(url, { headers: opts.headers });
  if (!res.ok) {
    throw new Error(`fetchAndCache: ${url} → HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = sha256OfBuffer(bytes);
  if (actual !== expectedSha256) {
    throw new IntegrityError(expectedSha256, actual, url);
  }
  await writeBlob(expectedSha256, bytes, opts.paths);
  return bytes;
}

function sha256OfBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
