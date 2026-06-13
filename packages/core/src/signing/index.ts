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

export {
  signManifestChecksum,
  verifyManifestSignature,
  SigningError,
  type SignOptions,
  type VerifyOptions,
} from "./sigstore.js";

export {
  evaluateSignerGate,
  type SignerGateInput,
  type SignerGateResult,
} from "./signerPolicy.js";
