import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cacheClear,
  cachePrune,
  cacheSize,
  fetchAndCache,
  getBlobPath,
  getCachePaths,
  hasBlob,
  IntegrityError,
  readBlob,
  writeBlob,
  BlobNotFoundError,
} from "../src/cache/index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wgcache-"));
  process.env.WORKGRAPH_HOME = tmpDir;
});

afterEach(async () => {
  delete process.env.WORKGRAPH_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("paths", () => {
  it("resolves cache dirs under WORKGRAPH_HOME", () => {
    const paths = getCachePaths();
    expect(paths.root).toBe(path.join(tmpDir, "cache"));
    expect(paths.blobs).toBe(path.join(tmpDir, "cache", "blobs"));
  });

  it("getBlobPath rejects non-sha256", () => {
    expect(() => getBlobPath("not-a-hash")).toThrow(/invalid sha256/);
  });

  it("getBlobPath fans out by first two chars", () => {
    const s = "a".repeat(64);
    const p = getBlobPath(s);
    expect(p.endsWith(path.join("aa", s))).toBe(true);
  });
});

describe("writeBlob/readBlob/hasBlob", () => {
  it("roundtrips bytes", async () => {
    const bytes = Buffer.from("hello world");
    const s = sha(bytes);
    expect(await hasBlob(s)).toBe(false);
    await writeBlob(s, bytes);
    expect(await hasBlob(s)).toBe(true);
    const got = await readBlob(s);
    expect(got.equals(bytes)).toBe(true);
  });

  it("rejects sha mismatch on write and leaves no temp", async () => {
    const bytes = Buffer.from("payload");
    const wrong = "0".repeat(64);
    await expect(writeBlob(wrong, bytes)).rejects.toBeInstanceOf(IntegrityError);
    const blobDir = path.join(tmpDir, "cache", "blobs");
    const exists = await fs.access(blobDir).then(() => true).catch(() => false);
    if (exists) {
      const top = await fs.readdir(blobDir);
      for (const sub of top) {
        const inner = await fs.readdir(path.join(blobDir, sub));
        expect(inner.some((f) => f.endsWith(".tmp"))).toBe(false);
      }
    }
  });

  it("readBlob throws BlobNotFoundError on miss", async () => {
    await expect(readBlob("b".repeat(64))).rejects.toBeInstanceOf(
      BlobNotFoundError
    );
  });
});

describe("fetchAndCache", () => {
  it("short-circuits on cache hit", async () => {
    const bytes = Buffer.from("cached");
    const s = sha(bytes);
    await writeBlob(s, bytes);
    const fetchImpl = (() => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;
    const got = await fetchAndCache("http://nowhere/", s, { fetchImpl });
    expect(got.equals(bytes)).toBe(true);
  });

  it("fetches + writes on cache miss", async () => {
    const bytes = Buffer.from("fresh");
    const s = sha(bytes);
    const fetchImpl: typeof fetch = async () =>
      new Response(bytes, { status: 200 });
    const got = await fetchAndCache("http://x/", s, { fetchImpl });
    expect(got.equals(bytes)).toBe(true);
    expect(await hasBlob(s)).toBe(true);
  });

  it("throws IntegrityError on hash mismatch from remote", async () => {
    const bytes = Buffer.from("tampered");
    const fetchImpl: typeof fetch = async () =>
      new Response(bytes, { status: 200 });
    await expect(
      fetchAndCache("http://x/", "f".repeat(64), { fetchImpl })
    ).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe("cacheSize/cachePrune/cacheClear", () => {
  it("size sums bytes + entry count", async () => {
    const a = Buffer.from("one");
    const b = Buffer.from("twotwo");
    await writeBlob(sha(a), a);
    await writeBlob(sha(b), b);
    const s = await cacheSize();
    expect(s.entryCount).toBe(2);
    expect(s.totalBytes).toBe(a.length + b.length);
  });

  it("prune respects maxAgeMs", async () => {
    const bytes = Buffer.from("old");
    const s = sha(bytes);
    await writeBlob(s, bytes);
    const blobPath = getBlobPath(s);
    const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    await fs.utimes(blobPath, past, past);
    const result = await cachePrune({ maxAgeMs: 1000 * 60 * 60 * 24 * 7 });
    expect(result.removed).toBe(1);
    expect(await hasBlob(s)).toBe(false);
  });

  it("prune is a no-op when nothing older than maxAge", async () => {
    const bytes = Buffer.from("fresh");
    await writeBlob(sha(bytes), bytes);
    const result = await cachePrune({ maxAgeMs: 1000 * 60 * 60 * 24 * 30 });
    expect(result.removed).toBe(0);
    expect(result.freed).toBe(0);
  });

  it("clear removes every blob", async () => {
    const a = Buffer.from("one");
    const b = Buffer.from("two");
    await writeBlob(sha(a), a);
    await writeBlob(sha(b), b);
    const result = await cacheClear();
    expect(result.removed).toBe(2);
    const s = await cacheSize();
    expect(s.entryCount).toBe(0);
  });
});
