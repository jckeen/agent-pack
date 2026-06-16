/**
 * Phase 4 signing types.
 *
 * AgentPack signs the `manifestChecksum` (hex sha256 of the raw AGENTPACK.yaml
 * bytes) using Sigstore keyless flow: an OIDC token proves the publisher's
 * identity, Fulcio issues a short-lived X.509 cert binding that identity to a
 * fresh ephemeral keypair, cosign signs the manifest hash, the signature +
 * cert get logged to Rekor for tamper-evident transparency.
 *
 * The lockfile reserves a single `signatures.manifest: string` slot. We pack
 * the full Sigstore Bundle into that string as base64-encoded JSON. Verifiers
 * decode and call `@sigstore/verify` to confirm cert chain, signature, and
 * Rekor inclusion proof.
 */

import { z } from "zod";

import { releaseDescriptorSchema } from "./releaseDescriptor.js";

/** Lowercase hex sha256 — same shape as everywhere else in the codebase. */
export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "sha256 must be lowercase hex, 64 chars");

/**
 * Signer identity claims surfaced from the Fulcio cert SAN. For GitHub
 * OIDC the SAN is `https://github.com/<user>` (for personal tokens) or
 * `https://github.com/<owner>/<repo>/.github/workflows/<wf>@<ref>` (for
 * Actions tokens). For Google OIDC it's an email URI.
 */
export const signerIdentitySchema = z.object({
  /** SAN URI from the Fulcio cert — the human-readable identity claim. */
  san: z.string().min(1),
  /** OIDC issuer URL — `https://github.com/login/oauth` for personal, etc. */
  issuer: z.string().min(1),
  /** Cert notBefore in ISO-8601 — informational, the Bundle has it canonically. */
  notBefore: z.string(),
  /** Cert notAfter in ISO-8601 — informational. */
  notAfter: z.string(),
});

export type SignerIdentity = z.infer<typeof signerIdentitySchema>;

/**
 * The decoded Sigstore Bundle JSON shape — only the fields we surface for
 * display. The full bundle survives as base64 in the lockfile slot and is
 * the source of truth for verification.
 */
export const signatureMetadataSchema = z.object({
  identity: signerIdentitySchema,
  /** Rekor log index — globally unique within the Rekor instance. */
  rekorLogIndex: z.number().int().nonnegative(),
  /** Hex SHA-256 of the Rekor log entry; lets you address it directly. */
  rekorLogId: z.string().min(1),
  /** Rekor canonical URL for human inspection. */
  rekorLogUrl: z.string().url(),
  /** ISO-8601 — when Rekor logged the inclusion. */
  signedAt: z.string(),
});

export type SignatureMetadata = z.infer<typeof signatureMetadataSchema>;

/**
 * What goes into the lockfile slot. We pack the bundle JSON as base64 so it
 * fits in the existing `LockfileSignatures.manifest: string` slot without a
 * schema bump.
 */
export const signedManifestSchema = z.object({
  /**
   * For v1 envelopes: the raw 64-char hex digest of AGENTPACK.yaml bytes, and
   * also the SIGNED payload. For v2 envelopes: still the manifest digest (kept
   * for display + the registry's manifest-mismatch tie), but the SIGNED payload
   * is `canonicalReleaseDigest(releaseDescriptor)` — see issue #35.
   */
  manifestChecksum: sha256HexSchema,
  /** Base64-encoded Sigstore Bundle JSON. Authoritative for verification. */
  bundleB64: z.string().min(1),
  /** Surface fields decoded from the bundle for display / quick checks. */
  metadata: signatureMetadataSchema,
  /**
   * Schema version of this envelope. v1 = manifest-only signature (legacy,
   * partial coverage). v2 = full-artifact: `releaseDescriptor` is present and
   * its canonical digest is what the bundle signs (#35). Defaults to 1 for
   * back-compat with envelopes that predate the descriptor.
   */
  envelopeVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  /**
   * v2 only — the canonical release descriptor whose digest the bundle signs.
   * Carrying it in the envelope lets the verifier recompute the signed digest
   * and check downloaded files against the SIGNED digest set rather than
   * registry-served metadata. Absent on v1 (legacy) envelopes.
   */
  releaseDescriptor: releaseDescriptorSchema.optional(),
});

export type SignedManifest = z.infer<typeof signedManifestSchema>;

/** Outcome of a verification call. Discriminated union — no exceptions. */
export type VerifyResult =
  | { valid: true; metadata: SignatureMetadata }
  | { valid: false; reason: VerifyFailureReason; detail?: string };

export type VerifyFailureReason =
  | "envelope_invalid" // base64/JSON/schema problem before crypto
  | "checksum_mismatch" // signed checksum != observed manifest checksum
  | "artifact_mismatch" // a downloaded file's bytes != the SIGNED descriptor (#35)
  | "signature_invalid" // cosign verify said no
  | "cert_invalid" // chain to Fulcio failed
  | "cert_expired" // signed outside notBefore..notAfter
  | "rekor_inclusion_failed" // log inclusion proof did not check out
  | "identity_mismatch" // SAN/issuer didn't match an expected identity
  | "network_error" // Rekor/Fulcio unreachable
  | "unknown_error"; // catch-all, always with a detail
