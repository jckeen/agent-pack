/**
 * Phase 4 — Sigstore keyless signing + verification.
 *
 * Uses the Sigstore JS SDK directly:
 *
 *   - `@sigstore/sign`     : FulcioSigner + DSSEBundleBuilder + RekorWitness.
 *                            Produces a Sigstore Bundle that wraps cert + sig
 *                            + Rekor inclusion proof.
 *   - `@sigstore/verify`   : Verifier with TrustedRoot from sigstore-tuf.
 *   - `@sigstore/bundle`   : Bundle JSON ↔ object conversion + canonicalization.
 *
 * Why the SDK and not the cosign binary: pure-Node means the registry, the
 * CLI, and CI can all sign/verify without shipping a Go binary or running
 * Docker. The trade-off is being version-locked to the Sigstore JS release
 * cadence — acceptable for v1.
 *
 * OIDC token sourcing:
 *
 *   1. Explicit `identityToken` in opts          — for tests/CI script flows
 *   2. `SIGSTORE_ID_TOKEN` env var               — recommended for local dev
 *   3. GitHub Actions ambient OIDC               — auto-detected via env
 *
 * The umbrella `sigstore` npm package wraps these into `sign()` / `verify()`,
 * but using the sub-packages directly keeps our dependency surface smaller
 * and the failure modes more discoverable.
 */

import { bundleFromJSON, bundleToJSON, type Bundle } from "@sigstore/bundle";
import { DSSEBundleBuilder, FulcioSigner, RekorWitness } from "@sigstore/sign";

import type {
  SignatureMetadata,
  SignedManifest,
  VerifyFailureReason,
  VerifyResult,
} from "./types.js";
import { signedManifestSchema } from "./types.js";
import {
  buildReleaseDescriptor,
  canonicalReleaseDigest,
  verifyFilesAgainstDescriptor,
  type ReleaseDescriptor,
  type ReleaseFileEntry,
} from "./releaseDescriptor.js";

const DEFAULT_FULCIO_URL = "https://fulcio.sigstore.dev";
const DEFAULT_REKOR_URL = "https://rekor.sigstore.dev";

export interface SignOptions {
  /** 64-char lowercase hex sha256 of the manifest YAML. */
  manifestChecksum: string;
  /** OIDC token; falls back to env if omitted. Required ultimately. */
  identityToken?: string;
  /** OIDC issuer hint for ambient detection; defaults to "sigstore". */
  oidcIssuer?: string;
  /** Override Fulcio CA URL — test/staging. */
  fulcioBaseURL?: string;
  /** Override Rekor URL — test/staging. */
  rekorBaseURL?: string;
}

/**
 * Options for `signReleaseDescriptor` (issue #35). Supply EITHER a prebuilt
 * `descriptor` OR `manifestSha256` + `files` to have one built canonically.
 */
export type SignReleaseOptions = {
  /** OIDC token; falls back to env if omitted. */
  identityToken?: string;
  /** OIDC issuer hint for ambient detection. */
  oidcIssuer?: string;
  /** Override Fulcio CA URL — test/staging. */
  fulcioBaseURL?: string;
  /** Override Rekor URL — test/staging. */
  rekorBaseURL?: string;
} & (
  | { descriptor: ReleaseDescriptor; manifestSha256?: never; files?: never }
  | { descriptor?: never; manifestSha256: string; files: ReleaseFileEntry[] }
);

export interface VerifyOptions {
  /** What we observed locally; sign- and verify-time must agree. */
  manifestChecksum: string;
  /** The envelope as it lives in the lockfile. */
  signed: SignedManifest;
  /** If set, fail when the cert SAN does not equal this string. */
  expectedSAN?: string;
  /** If set, fail when the cert issuer does not equal this string. */
  expectedIssuer?: string;
  /** Allow offline verification — skip Rekor network check. Default false. */
  offline?: boolean;
  /**
   * When true, fail verification if neither `expectedSAN` nor
   * `expectedIssuer` is supplied. Trust-decision paths (`--require-sig`,
   * registry publish-finalize) MUST set this so that ANY valid Sigstore
   * signature can't pass — only signatures bound to a known publisher
   * identity should. Default false for back-compat with audit-only call
   * sites. Added 2026-05-19 (iter-5 security-reviewer CRITICAL-1).
   */
  requireIdentity?: boolean;
}

/**
 * Options for `verifyReleaseSignature` (issue #35) — full-artifact trust gate.
 */
export interface VerifyReleaseOptions {
  /** sha256 of the AGENTPACK.yaml bytes actually materialized on disk. */
  manifestSha256: string;
  /**
   * sha256 of every installable file actually downloaded. Checked against the
   * SIGNED descriptor — the bytes, not registry-served metadata.
   */
  observedFiles: Array<{ path: string; sha256: string }>;
  /** The envelope as served by the registry / stored in the lockfile. */
  signed: SignedManifest;
  /** If set, fail when the cert SAN does not equal this string. */
  expectedSAN?: string;
  /** If set, fail when the cert issuer does not equal this string. */
  expectedIssuer?: string;
  /** Allow offline verification — skip Rekor network check. Default false. */
  offline?: boolean;
  /** See VerifyOptions.requireIdentity. */
  requireIdentity?: boolean;
}

/** Outcome of `verifyReleaseSignature` — adds the coverage level. */
export type ReleaseVerifyResult =
  | {
      valid: true;
      metadata: SignatureMetadata;
      /** full-artifact = v2 descriptor signed; manifest-only = legacy v1. */
      coverage: "full-artifact" | "manifest-only";
    }
  | { valid: false; reason: VerifyFailureReason; detail?: string };

/**
 * Sign the `manifestChecksum` using Sigstore keyless flow. Returns the
 * envelope shape that goes into `lockfile.signatures.manifest`.
 */
export async function signManifestChecksum(opts: SignOptions): Promise<SignedManifest> {
  const identityToken = resolveIdentityToken(opts);
  if (!identityToken) {
    throw new SigningError(
      "no_oidc_token",
      "No OIDC token available. Set SIGSTORE_ID_TOKEN, run under GitHub Actions, or pass identityToken.",
    );
  }

  const signer = new FulcioSigner({
    fulcioBaseURL: opts.fulcioBaseURL ?? DEFAULT_FULCIO_URL,
    identityProvider: { getToken: async () => identityToken },
  });
  const rekor = new RekorWitness({
    rekorBaseURL: opts.rekorBaseURL ?? DEFAULT_REKOR_URL,
  });
  const bundler = new DSSEBundleBuilder({
    signer,
    witnesses: [rekor],
    certificateChain: true,
  });

  let bundle: Bundle;
  try {
    bundle = await bundler.create({
      type: "application/vnd.agentpack.manifest+text",
      data: Buffer.from(opts.manifestChecksum, "utf-8"),
    });
  } catch (err) {
    throw new SigningError("sign_failed", (err as Error).message);
  }

  const bundleJson = bundleToJSON(bundle);
  const bundleB64 = Buffer.from(JSON.stringify(bundleJson), "utf-8").toString("base64");
  const metadata = extractMetadata(bundle);

  const envelope: SignedManifest = {
    manifestChecksum: opts.manifestChecksum,
    bundleB64,
    metadata,
    envelopeVersion: 1,
  };

  // Re-parse to guarantee the envelope round-trips its own schema.
  return signedManifestSchema.parse(envelope);
}

/**
 * Sign a full release artifact (issue #35). Builds the canonical release
 * descriptor from the manifest digest + every installable file digest, signs
 * the descriptor's digest via Sigstore keyless, and returns a v2 envelope that
 * embeds the descriptor. The signature therefore covers the WHOLE artifact, not
 * just the manifest.
 */
export async function signReleaseDescriptor(
  opts: SignReleaseOptions,
): Promise<SignedManifest> {
  const identityToken = resolveIdentityToken(opts);
  if (!identityToken) {
    throw new SigningError(
      "no_oidc_token",
      "No OIDC token available. Set SIGSTORE_ID_TOKEN, run under GitHub Actions, or pass identityToken.",
    );
  }

  const descriptor: ReleaseDescriptor = opts.descriptor
    ? opts.descriptor
    : buildReleaseDescriptor({
        manifestSha256: opts.manifestSha256,
        files: opts.files,
      });
  const releaseDigest = canonicalReleaseDigest(descriptor);

  const signer = new FulcioSigner({
    fulcioBaseURL: opts.fulcioBaseURL ?? DEFAULT_FULCIO_URL,
    identityProvider: { getToken: async () => identityToken },
  });
  const rekor = new RekorWitness({
    rekorBaseURL: opts.rekorBaseURL ?? DEFAULT_REKOR_URL,
  });
  const bundler = new DSSEBundleBuilder({
    signer,
    witnesses: [rekor],
    certificateChain: true,
  });

  let bundle: Bundle;
  try {
    bundle = await bundler.create({
      type: "application/vnd.agentpack.release+text",
      data: Buffer.from(releaseDigest, "utf-8"),
    });
  } catch (err) {
    throw new SigningError("sign_failed", (err as Error).message);
  }

  const bundleJson = bundleToJSON(bundle);
  const bundleB64 = Buffer.from(JSON.stringify(bundleJson), "utf-8").toString("base64");
  const metadata = extractMetadata(bundle);

  const envelope: SignedManifest = {
    manifestChecksum: descriptor.manifestSha256,
    bundleB64,
    metadata,
    envelopeVersion: 2,
    releaseDescriptor: descriptor,
  };

  return signedManifestSchema.parse(envelope);
}

/**
 * Verify a signed manifest against the observed `manifestChecksum`. Returns
 * a discriminated union — no exceptions for verification failure.
 */
export async function verifyManifestSignature(opts: VerifyOptions): Promise<VerifyResult> {
  // 1. Schema sanity.
  let envelope: SignedManifest;
  try {
    envelope = signedManifestSchema.parse(opts.signed);
  } catch (err) {
    return {
      valid: false,
      reason: "envelope_invalid",
      detail: (err as Error).message,
    };
  }

  // 2. Checksum must match what the verifier observed locally.
  if (envelope.manifestChecksum !== opts.manifestChecksum) {
    return {
      valid: false,
      reason: "checksum_mismatch",
      detail: `signed=${envelope.manifestChecksum} observed=${opts.manifestChecksum}`,
    };
  }

  // 3-5. Identity gate + crypto + authoritative cert identity. For a v1
  // (manifest-only) envelope the SIGNED payload IS the manifest checksum.
  return verifyIdentityAndCrypto(envelope, opts.manifestChecksum, opts);
}

/**
 * Full-artifact verification (issue #35). Verifies a v2 envelope whose Sigstore
 * bundle signs the RELEASE DESCRIPTOR digest (manifest hash + every file
 * digest), then checks the OBSERVED downloaded files against that SIGNED
 * descriptor — closing the gap where the registry served the per-file hashes.
 *
 * A v1 (legacy) envelope is accepted with `coverage: "manifest-only"` so old
 * signatures still verify; the caller surfaces a partial-coverage note. A v2
 * envelope is `coverage: "full-artifact"`.
 */
export async function verifyReleaseSignature(
  opts: VerifyReleaseOptions,
): Promise<ReleaseVerifyResult> {
  // 1. Schema sanity.
  let envelope: SignedManifest;
  try {
    envelope = signedManifestSchema.parse(opts.signed);
  } catch (err) {
    return { valid: false, reason: "envelope_invalid", detail: (err as Error).message };
  }

  // 2. The envelope's manifest digest must match what we observed locally —
  // same tie as the v1 path; protects the manifest leg regardless of version.
  if (envelope.manifestChecksum !== opts.manifestSha256) {
    return {
      valid: false,
      reason: "checksum_mismatch",
      detail: `signed-manifest=${envelope.manifestChecksum} observed=${opts.manifestSha256}`,
    };
  }

  // 3. Legacy v1 envelope — no descriptor. The signature covers the manifest
  // ONLY. Verify it as such and report partial coverage; the file-set check is
  // not possible (the bytes were never signed).
  if (envelope.envelopeVersion === 1 || !envelope.releaseDescriptor) {
    const crypto = await verifyIdentityAndCrypto(envelope, envelope.manifestChecksum, opts);
    if (!crypto.valid) return crypto;
    return { valid: true, metadata: crypto.metadata, coverage: "manifest-only" };
  }

  // 4. v2 envelope — the SIGNED payload is the descriptor digest. The
  // descriptor's own manifestSha256 must also match what we observed (it's part
  // of the signed bytes, but checking here gives a precise failure reason).
  const descriptor = envelope.releaseDescriptor;
  if (descriptor.manifestSha256 !== opts.manifestSha256) {
    return {
      valid: false,
      reason: "checksum_mismatch",
      detail: `descriptor-manifest=${descriptor.manifestSha256} observed=${opts.manifestSha256}`,
    };
  }
  const releaseDigest = canonicalReleaseDigest(descriptor);
  const crypto = await verifyIdentityAndCrypto(envelope, releaseDigest, opts);
  if (!crypto.valid) return crypto;

  // 5. Check the OBSERVED downloaded files against the SIGNED descriptor. This
  // is the control the manifest-only signature lacked: swapped atom bytes are
  // rejected even when the registry served a matching (malicious) per-file
  // hash, because the descriptor — not registry metadata — is the source of
  // truth and the descriptor is covered by the verified signature.
  const fileCheck = verifyFilesAgainstDescriptor(descriptor, opts.observedFiles);
  if (!fileCheck.ok) {
    const parts: string[] = [];
    if (fileCheck.mismatches.length > 0) {
      parts.push(`tampered: ${fileCheck.mismatches.map((m) => m.path).join(", ")}`);
    }
    if (fileCheck.missing.length > 0) {
      parts.push(`missing: ${fileCheck.missing.join(", ")}`);
    }
    if (fileCheck.extra.length > 0) {
      parts.push(`unexpected: ${fileCheck.extra.join(", ")}`);
    }
    return { valid: false, reason: "artifact_mismatch", detail: parts.join("; ") };
  }
  return { valid: true, metadata: crypto.metadata, coverage: "full-artifact" };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Shared steps 3-5 of verification, parameterized by the SIGNED payload string.
 * For a manifest-only signature this is the manifest checksum; for a
 * full-artifact signature it's the release-descriptor digest. The identity gate
 * and the authoritative cert re-derivation are identical in both cases.
 */
async function verifyIdentityAndCrypto(
  envelope: SignedManifest,
  signedPayload: string,
  opts: {
    expectedSAN?: string;
    expectedIssuer?: string;
    offline?: boolean;
    requireIdentity?: boolean;
  },
): Promise<VerifyResult> {
  // 3. Identity gate — refuse early if the surfaced SAN/issuer doesn't match.
  // When `requireIdentity: true` is passed, an absent expectedSAN AND
  // expectedIssuer is itself a failure — without that, ANY valid Sigstore
  // signature passes (including one minted by an attacker's GitHub account).
  // Callers in trust-decision paths (--require-sig, registry publish flow)
  // MUST set requireIdentity. From security-reviewer CRITICAL-1 (iter-5).
  if (opts.requireIdentity && !opts.expectedSAN && !opts.expectedIssuer) {
    return {
      valid: false,
      reason: "identity_mismatch",
      detail:
        "requireIdentity set but no expectedSAN/expectedIssuer provided — refusing trust-on-first-publish",
    };
  }
  // The two comparisons below are a FAST-FAIL ONLY against the envelope's
  // self-reported identity, which is attacker-controllable JSON. They catch
  // honest mismatches without a network round-trip but are NOT the security
  // control — an attacker can edit `envelope.metadata.identity.san` to match.
  // The authoritative check is step 5, against the SAN re-derived from the
  // cryptographically-verified certificate. (security-reviewer CRITICAL-1,
  // iter-9 / ISC-289.)
  if (opts.expectedSAN && envelope.metadata.identity.san !== opts.expectedSAN) {
    return {
      valid: false,
      reason: "identity_mismatch",
      detail: `san: expected ${opts.expectedSAN}, got ${envelope.metadata.identity.san}`,
    };
  }
  if (opts.expectedIssuer && envelope.metadata.identity.issuer !== opts.expectedIssuer) {
    return {
      valid: false,
      reason: "identity_mismatch",
      detail: `issuer: expected ${opts.expectedIssuer}, got ${envelope.metadata.identity.issuer}`,
    };
  }

  // 4. Cryptographic verification via the `sigstore` umbrella package, which
  // wraps `@sigstore/verify` + bundled trust roots. Lazy-imported so the
  // signing path stays light and the CLI cold-starts fast.
  //
  // The umbrella's verify() takes the SERIALIZED bundle (JSON shape from the
  // protobuf serializer), not the protobuf message object — so we pass the
  // parsed JSON directly rather than going through bundleFromJSON().
  let bundleJson: unknown;
  try {
    bundleJson = JSON.parse(Buffer.from(envelope.bundleB64, "base64").toString("utf-8"));
  } catch (err) {
    return {
      valid: false,
      reason: "envelope_invalid",
      detail: `bundle decode failed: ${(err as Error).message}`,
    };
  }

  try {
    const sigstore = await import("sigstore");
    // The umbrella's verify() consults Sigstore's trusted root TUF data,
    // checks the cert chain, signature over the payload, and Rekor inclusion.
    // It throws on failure; success returns void.
    await sigstore.verify(bundleJson as never, Buffer.from(signedPayload, "utf-8"), {
      tlogThreshold: opts.offline ? 0 : 1,
    });
  } catch (err) {
    return classifyVerifyError(err as Error);
  }

  // 5. AUTHORITATIVE identity check. The bundle is now cryptographically
  // verified — re-derive the signer identity from the certificate INSIDE the
  // verified bundle (not the attacker-controllable `envelope.metadata`), and
  // make the trust decision against that. This closes the ISC-289 hole where a
  // valid bundle re-signed by any identity could carry a forged
  // `metadata.identity.san` string and pass the gate. The returned metadata is
  // also the cert-derived one, so callers (and the registry publish flow that
  // persists the signer) record the real identity.
  let verifiedMetadata: SignatureMetadata;
  try {
    verifiedMetadata = extractMetadata(bundleFromJSON(bundleJson as never));
  } catch (err) {
    return {
      valid: false,
      reason: "cert_invalid",
      detail: `could not extract identity from the verified bundle: ${(err as Error).message}`,
    };
  }
  if (opts.expectedSAN && verifiedMetadata.identity.san !== opts.expectedSAN) {
    return {
      valid: false,
      reason: "identity_mismatch",
      detail: `verified-cert san: expected ${opts.expectedSAN}, got ${verifiedMetadata.identity.san}`,
    };
  }
  if (opts.expectedIssuer && verifiedMetadata.identity.issuer !== opts.expectedIssuer) {
    return {
      valid: false,
      reason: "identity_mismatch",
      detail: `verified-cert issuer: expected ${opts.expectedIssuer}, got ${verifiedMetadata.identity.issuer}`,
    };
  }
  return { valid: true, metadata: verifiedMetadata };
}

function resolveIdentityToken(opts: { identityToken?: string }): string | undefined {
  if (opts.identityToken) return opts.identityToken;
  const env = process.env;
  if (env["SIGSTORE_ID_TOKEN"]) return env["SIGSTORE_ID_TOKEN"];
  // Ambient GitHub Actions OIDC is handled by the caller — the calling CLI
  // detects the env vars and routes through @sigstore/sign's built-in
  // CIContextProvider before reaching this function. By that point we either
  // have a token in hand or we want to abort with a clear error.
  return undefined;
}

function extractMetadata(bundle: Bundle): SignatureMetadata {
  // The bundle's verificationMaterial holds the signing cert; tlogEntries
  // hold the Rekor proof. We surface the convenience fields and keep the
  // full bundle as the source of truth.
  const certChain =
    bundle.verificationMaterial.content?.$case === "x509CertificateChain"
      ? bundle.verificationMaterial.content.x509CertificateChain
      : bundle.verificationMaterial.content?.$case === "certificate"
        ? { certificates: [bundle.verificationMaterial.content.certificate] }
        : undefined;
  const leafDer = certChain?.certificates?.[0]?.rawBytes;
  const { san, issuer, notBefore, notAfter } = leafDer
    ? parseLeafCert(leafDer)
    : {
        san: "unknown",
        issuer: "unknown",
        notBefore: new Date(0).toISOString(),
        notAfter: new Date(0).toISOString(),
      };

  const tlogEntry = bundle.verificationMaterial.tlogEntries?.[0];
  const logIndex = tlogEntry?.logIndex ? Number(tlogEntry.logIndex) : 0;
  const logId = tlogEntry?.logId?.keyId
    ? Buffer.from(tlogEntry.logId.keyId).toString("hex")
    : "";
  const integratedTime = tlogEntry?.integratedTime
    ? new Date(Number(tlogEntry.integratedTime) * 1000).toISOString()
    : new Date().toISOString();

  return {
    identity: { san, issuer, notBefore, notAfter },
    rekorLogIndex: logIndex,
    rekorLogId: logId,
    rekorLogUrl: `${DEFAULT_REKOR_URL}/api/v1/log/entries?logIndex=${logIndex}`,
    signedAt: integratedTime,
  };
}

/**
 * Parse a DER-encoded X.509 certificate just enough to extract SAN, issuer
 * O= field, notBefore, and notAfter. The full crypto check happens in
 * `@sigstore/verify`; this is purely for display + the identity gate.
 *
 * Uses Node's built-in `crypto.X509Certificate` (available since Node 15.6).
 */
function parseLeafCert(der: Uint8Array): {
  san: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
} {
  // Use a dynamic require so the import doesn't fail under unusual bundlers.
  const { X509Certificate } = require("node:crypto") as typeof import("node:crypto");
  const cert = new X509Certificate(Buffer.from(der));
  // X509Certificate#subjectAltName returns a string like
  // "URI:https://github.com/foo, email:foo@bar". For Sigstore keyless, the
  // URI SAN is the identity.
  const sanField = cert.subjectAltName ?? "";
  const uriMatch = /URI:([^,\s]+)/i.exec(sanField);
  const emailMatch = /email:([^,\s]+)/i.exec(sanField);
  const san = (uriMatch?.[1] ?? emailMatch?.[1] ?? sanField) || "unknown";
  // Fulcio always issues with issuer O=sigstore.dev or O=Sigstore. The
  // OIDC issuer is in an x509 extension (1.3.6.1.4.1.57264.1.1) which
  // X509Certificate doesn't expose directly; we leave the field as the
  // cert subject's organization for v1 and read the OIDC issuer extension
  // in a follow-up when JS APIs expose it cleanly.
  const issuer =
    cert.issuer
      .split("\n")
      .find((line) => line.startsWith("O="))
      ?.replace(/^O=/, "") ?? "sigstore.dev";
  return {
    san,
    issuer,
    notBefore: new Date(cert.validFrom).toISOString(),
    notAfter: new Date(cert.validTo).toISOString(),
  };
}

function classifyVerifyError(err: Error): VerifyResult {
  const m = err.message ?? "";
  if (/expired|notAfter|notBefore/i.test(m)) {
    return { valid: false, reason: "cert_expired", detail: m };
  }
  if (/inclusion|rekor/i.test(m)) {
    return { valid: false, reason: "rekor_inclusion_failed", detail: m };
  }
  if (/certificate|chain|issuer/i.test(m)) {
    return { valid: false, reason: "cert_invalid", detail: m };
  }
  if (/signature|verify/i.test(m)) {
    return { valid: false, reason: "signature_invalid", detail: m };
  }
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(m)) {
    return { valid: false, reason: "network_error", detail: m };
  }
  return { valid: false, reason: "unknown_error", detail: m };
}

export class SigningError extends Error {
  constructor(
    readonly code:
      | "no_oidc_token"
      | "sign_failed"
      | "bundle_invalid"
      | "fulcio_error"
      | "rekor_error",
    message: string,
  ) {
    super(message);
    this.name = "SigningError";
  }
}
