/**
 * Issue #35 — full-artifact signing.
 *
 * The Sigstore bundle historically covered only `manifestSha256`, so a
 * registry/R2 swap of atom bytes (with matching malicious per-file hashes
 * served by the registry) still verified. The fix introduces a canonical
 * *release descriptor* = manifestSha256 + sorted {path, sha256, bytes,
 * atomId} for every installable file, signs THAT, and verifies downloaded
 * files against the SIGNED digest set rather than registry-served metadata.
 *
 * These tests are pure (no network, no Sigstore crypto): they pin the
 * descriptor canonicalization + the file-set verification helper.
 */

import { describe, expect, it } from "vitest";

import {
  buildReleaseDescriptor,
  canonicalReleaseDigest,
  verifyFilesAgainstDescriptor,
  type ReleaseDescriptor,
} from "../../src/signing/releaseDescriptor.js";

const MANIFEST_SHA = "a".repeat(64);
const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);

describe("buildReleaseDescriptor", () => {
  it("sorts files by path so input order does not change the digest", () => {
    const d1 = buildReleaseDescriptor({
      manifestSha256: MANIFEST_SHA,
      files: [
        { path: "b.md", sha256: HASH_B, bytes: 2, atomId: "atom-b" },
        { path: "a.md", sha256: HASH_A, bytes: 1, atomId: "atom-a" },
      ],
    });
    const d2 = buildReleaseDescriptor({
      manifestSha256: MANIFEST_SHA,
      files: [
        { path: "a.md", sha256: HASH_A, bytes: 1, atomId: "atom-a" },
        { path: "b.md", sha256: HASH_B, bytes: 2, atomId: "atom-b" },
      ],
    });
    expect(d1.files.map((f) => f.path)).toEqual(["a.md", "b.md"]);
    expect(canonicalReleaseDigest(d1)).toBe(canonicalReleaseDigest(d2));
  });

  it("stamps descriptorVersion 1 and carries manifestSha256", () => {
    const d = buildReleaseDescriptor({
      manifestSha256: MANIFEST_SHA,
      files: [{ path: "a.md", sha256: HASH_A, bytes: 1 }],
    });
    expect(d.descriptorVersion).toBe(1);
    expect(d.manifestSha256).toBe(MANIFEST_SHA);
  });

  it("produces a 64-char hex release digest", () => {
    const d = buildReleaseDescriptor({
      manifestSha256: MANIFEST_SHA,
      files: [{ path: "a.md", sha256: HASH_A, bytes: 1 }],
    });
    expect(canonicalReleaseDigest(d)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the digest when any file hash changes (artifact-swap detection)", () => {
    const base = buildReleaseDescriptor({
      manifestSha256: MANIFEST_SHA,
      files: [{ path: "a.md", sha256: HASH_A, bytes: 1, atomId: "x" }],
    });
    const swapped = buildReleaseDescriptor({
      manifestSha256: MANIFEST_SHA,
      // Same path/bytes, DIFFERENT bytes hash — a malicious swap.
      files: [{ path: "a.md", sha256: HASH_B, bytes: 1, atomId: "x" }],
    });
    expect(canonicalReleaseDigest(base)).not.toBe(canonicalReleaseDigest(swapped));
  });
});

describe("verifyFilesAgainstDescriptor", () => {
  const descriptor: ReleaseDescriptor = buildReleaseDescriptor({
    manifestSha256: MANIFEST_SHA,
    files: [
      { path: "a.md", sha256: HASH_A, bytes: 1, atomId: "atom-a" },
      { path: "b.md", sha256: HASH_B, bytes: 2, atomId: "atom-b" },
    ],
  });

  it("passes when every observed file hash matches the SIGNED digest set", () => {
    const result = verifyFilesAgainstDescriptor(descriptor, [
      { path: "a.md", sha256: HASH_A },
      { path: "b.md", sha256: HASH_B },
    ]);
    expect(result.ok).toBe(true);
  });

  it("FAILS when a file's observed hash differs from the signed descriptor", () => {
    // The registry serves a (malicious) matching metadata hash, but the SIGNED
    // descriptor still pins the real one — this is the closed gap.
    const result = verifyFilesAgainstDescriptor(descriptor, [
      { path: "a.md", sha256: HASH_B }, // swapped bytes
      { path: "b.md", sha256: HASH_B },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.mismatches.map((m) => m.path)).toContain("a.md");
    }
  });

  it("FAILS when a signed file is missing from the observed set", () => {
    const result = verifyFilesAgainstDescriptor(descriptor, [
      { path: "a.md", sha256: HASH_A },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("b.md");
    }
  });

  it("FAILS when an extra file not in the descriptor is observed (injection)", () => {
    const result = verifyFilesAgainstDescriptor(descriptor, [
      { path: "a.md", sha256: HASH_A },
      { path: "b.md", sha256: HASH_B },
      { path: "evil.sh", sha256: HASH_A },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.extra).toContain("evil.sh");
    }
  });
});
