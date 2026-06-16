/**
 * Phase 4 — signing & verification (Sigstore keyless).
 *
 * The minimal public surface for callers (CLI, registry, tests):
 */

export type {
  SignerIdentity,
  SignatureMetadata,
  SignedManifest,
  VerifyResult,
  VerifyFailureReason,
} from "./types.js";

export {
  signedManifestSchema,
  signatureMetadataSchema,
  signerIdentitySchema,
} from "./types.js";

export type {
  ReleaseDescriptor,
  ReleaseFileEntry,
  FileVerifyResult,
} from "./releaseDescriptor.js";

export {
  releaseDescriptorSchema,
  releaseFileEntrySchema,
  buildReleaseDescriptor,
  canonicalReleaseDigest,
  verifyFilesAgainstDescriptor,
} from "./releaseDescriptor.js";

export {
  signManifestChecksum,
  signReleaseDescriptor,
  verifyManifestSignature,
  verifyReleaseSignature,
  SigningError,
  type SignOptions,
  type SignReleaseOptions,
  type VerifyOptions,
  type VerifyReleaseOptions,
  type ReleaseVerifyResult,
} from "./sigstore.js";

export {
  evaluateSignerGate,
  type SignerGateInput,
  type SignerGateResult,
} from "./signerPolicy.js";
