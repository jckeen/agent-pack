/**
 * Issue #35 — full-artifact signing via a canonical *release descriptor*.
 *
 * Historically the Sigstore bundle covered only `manifestSha256` (the hash of
 * AGENTPACK.yaml). Atom file bytes were fetched and checked against per-file
 * hashes served BY THE REGISTRY — so a registry/R2 compromise could serve
 * malicious atom bytes whose (malicious) per-file hash matched the served
 * metadata, leaving the manifest bytes (and therefore the signature) intact.
 *
 * The release descriptor closes that gap. It is the canonical set of EVERY
 * installable file digest plus the manifest digest. We sign the descriptor's
 * digest, so the signature covers the whole artifact. At install time the
 * downloaded files are checked against the SIGNED descriptor — not the
 * registry-served metadata — so swapped bytes are detected.
 */

import { z } from "zod";

import { canonicalJson, sha256Hex } from "../install/checksum.js";

/** Lowercase hex sha256 — 64 chars. Mirrors the rest of the codebase. */
const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "sha256 must be lowercase hex, 64 chars");

/** One installable file's signed digest entry. */
export const releaseFileEntrySchema = z.object({
  /** Project-relative path. */
  path: z.string().min(1),
  /** Lowercase-hex sha256 of the file's canonical bytes. */
  sha256: sha256HexSchema,
  /** Byte count of the canonical bytes. */
  bytes: z.number().int().nonnegative(),
  /** Owning atom id, when the file belongs to one. */
  atomId: z.string().min(1).optional(),
});

export type ReleaseFileEntry = z.infer<typeof releaseFileEntrySchema>;

/**
 * The signed artifact descriptor. The descriptor's canonical digest
 * (`canonicalReleaseDigest`) is what the Sigstore bundle signs, so any change
 * to the manifest hash OR any file digest invalidates the signature.
 */
export const releaseDescriptorSchema = z.object({
  /** Schema version — bump on shape change. */
  descriptorVersion: z.literal(1).default(1),
  /** sha256 of the raw AGENTPACK.yaml bytes. */
  manifestSha256: sha256HexSchema,
  /** Sorted-by-path digest set for every installable file. */
  files: z.array(releaseFileEntrySchema),
});

export type ReleaseDescriptor = z.infer<typeof releaseDescriptorSchema>;

export interface BuildReleaseDescriptorInput {
  manifestSha256: string;
  files: ReleaseFileEntry[];
}

/**
 * Build a canonical release descriptor. Files are sorted by path so the
 * descriptor (and therefore its signed digest) is deterministic regardless of
 * input order.
 */
export function buildReleaseDescriptor(
  input: BuildReleaseDescriptorInput,
): ReleaseDescriptor {
  const files = [...input.files]
    .map((f) => ({
      path: f.path,
      sha256: f.sha256,
      bytes: f.bytes,
      ...(f.atomId ? { atomId: f.atomId } : {}),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return releaseDescriptorSchema.parse({
    descriptorVersion: 1,
    manifestSha256: input.manifestSha256,
    files,
  });
}

/**
 * The 64-char hex digest that the Sigstore bundle signs. Computed over the
 * canonical JSON of the descriptor so key order / whitespace can't shift it.
 */
export function canonicalReleaseDigest(descriptor: ReleaseDescriptor): string {
  // Re-normalize through buildReleaseDescriptor's sort so a caller-supplied
  // descriptor with shuffled files still produces the same digest.
  const normalized = buildReleaseDescriptor({
    manifestSha256: descriptor.manifestSha256,
    files: descriptor.files,
  });
  return sha256Hex(canonicalJson(normalized));
}

export interface FileVerifyOk {
  ok: true;
}

export interface FileVerifyFail {
  ok: false;
  /** Files whose observed hash differs from the signed descriptor. */
  mismatches: Array<{ path: string; expected: string; actual: string }>;
  /** Signed files not present in the observed set. */
  missing: string[];
  /** Observed files not present in the signed descriptor. */
  extra: string[];
}

export type FileVerifyResult = FileVerifyOk | FileVerifyFail;

/**
 * Verify a set of OBSERVED file hashes against the SIGNED release descriptor.
 * This is the install-time control: callers pass the sha256 of the bytes they
 * actually downloaded, and we confirm each matches the descriptor exactly —
 * no extra files, no missing files, no swapped bytes.
 *
 * Only files declared in the descriptor are checked. The manifest itself is
 * verified separately (its digest is `descriptor.manifestSha256`).
 */
export function verifyFilesAgainstDescriptor(
  descriptor: ReleaseDescriptor,
  observed: Array<{ path: string; sha256: string }>,
): FileVerifyResult {
  const signed = new Map(descriptor.files.map((f) => [f.path, f.sha256]));
  const seen = new Map(observed.map((o) => [o.path, o.sha256]));

  const mismatches: Array<{ path: string; expected: string; actual: string }> = [];
  const missing: string[] = [];
  for (const [path, expected] of signed) {
    const actual = seen.get(path);
    if (actual === undefined) {
      missing.push(path);
    } else if (actual !== expected) {
      mismatches.push({ path, expected, actual });
    }
  }
  const extra: string[] = [];
  for (const path of seen.keys()) {
    if (!signed.has(path)) extra.push(path);
  }

  if (mismatches.length === 0 && missing.length === 0 && extra.length === 0) {
    return { ok: true };
  }
  return { ok: false, mismatches, missing, extra };
}
