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

import { bundleToJSON, type Bundle } from "@sigstore/bundle";
import {
  DSSEBundleBuilder,
  FulcioSigner,
  RekorWitness,
} from "@sigstore/sign";

import type {
  SignatureMetadata,
  SignedManifest,
  VerifyResult,
} from "./types.js";
import { signedManifestSchema } from "./types.js";

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
 * Sign the `manifestChecksum` using Sigstore keyless flow. Returns the
 * envelope shape that goes into `lockfile.signatures.manifest`.
 */
export async function signManifestChecksum(
  opts: SignOptions
): Promise<SignedManifest> {
  const identityToken = resolveIdentityToken(opts);
  if (!identityToken) {
    throw new SigningError(
      "no_oidc_token",
      "No OIDC token available. Set SIGSTORE_ID_TOKEN, run under GitHub Actions, or pass identityToken."
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
  const bundleB64 = Buffer.from(JSON.stringify(bundleJson), "utf-8").toString(
    "base64"
  );
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
 * Verify a signed manifest against the observed `manifestChecksum`. Returns
 * a discriminated union — no exceptions for verification failure.
 */
export async function verifyManifestSignature(
  opts: VerifyOptions
): Promise<VerifyResult> {
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
  if (opts.expectedSAN && envelope.metadata.identity.san !== opts.expectedSAN) {
    return {
      valid: false,
      reason: "identity_mismatch",
      detail: `san: expected ${opts.expectedSAN}, got ${envelope.metadata.identity.san}`,
    };
  }
  if (
    opts.expectedIssuer &&
    envelope.metadata.identity.issuer !== opts.expectedIssuer
  ) {
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
    bundleJson = JSON.parse(
      Buffer.from(envelope.bundleB64, "base64").toString("utf-8")
    );
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
    await sigstore.verify(
      bundleJson as never,
      Buffer.from(opts.manifestChecksum, "utf-8"),
      {
        tlogThreshold: opts.offline ? 0 : 1,
      }
    );
    return { valid: true, metadata: envelope.metadata };
  } catch (err) {
    return classifyVerifyError(err as Error);
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function resolveIdentityToken(opts: SignOptions): string | undefined {
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
  const issuer = cert.issuer
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
    message: string
  ) {
    super(message);
    this.name = "SigningError";
  }
}
