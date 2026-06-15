import { describe, expect, it, vi } from "vitest";

/**
 * Phase 4 — Sigstore verification negative-path coverage.
 *
 * `verifyManifestSignature` is the trust gate for a public release: a recent
 * fix (ae36022 / be6fa34, ISC-289) bound the trust decision to the certificate
 * INSIDE the cryptographically-verified bundle rather than the attacker-
 * controllable `envelope.metadata`. These tests pin the uncovered failure
 * branches without any network or real Sigstore crypto.
 *
 * Two boundaries are mocked, matching tests/signing/identity-binding.test.ts:
 *   - `sigstore.verify`            — the umbrella crypto check. Resolving it
 *                                     simulates a cryptographically-valid bundle
 *                                     (a real one can't be produced offline);
 *                                     rejecting it drives `classifyVerifyError`.
 *   - `@sigstore/bundle.bundleFromJSON` — controls the cert the production
 *                                     `extractMetadata` re-derives identity from
 *                                     in step 5 (the authoritative gate).
 *
 * `bundleFromJSON` is given a default no-cert bundle and overridden per-test
 * via `mockImplementationOnce` to inject a real DER cert with a known URI SAN,
 * so the genuine `parseLeafCert` (Node X509Certificate) runs unmocked.
 */

const sigstoreVerify = vi.fn().mockResolvedValue(undefined);

vi.mock("sigstore", () => ({
  verify: sigstoreVerify,
}));

vi.mock("@sigstore/bundle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sigstore/bundle")>();
  return {
    ...actual,
    // Default: a verified bundle with no x509 cert chain → SAN "unknown".
    bundleFromJSON: vi.fn(() => ({
      verificationMaterial: {
        content: { $case: "publicKey" },
        tlogEntries: [],
      },
    })),
  };
});

import { bundleFromJSON } from "@sigstore/bundle";

import { verifyManifestSignature } from "../src/signing/sigstore.js";
import type { SignedManifest } from "../src/signing/types.js";

const CHECKSUM = "a".repeat(64);

// A self-signed cert (O=sigstore.dev, CN=test) carrying a single URI SAN.
// Generated with openssl; `parseLeafCert` extracts:
//   san    = https://github.com/test-org/.github/workflows/publish.yml@refs/heads/main
//   issuer = sigstore.dev
const CERT_SAN =
  "https://github.com/test-org/.github/workflows/publish.yml@refs/heads/main";
const CERT_ISSUER = "sigstore.dev";
const CERT_DER_B64 =
  "MIIDUTCCAjmgAwIBAgIUZXaSUzE7o9iB1DWs6+26MFBfYSQwDQYJKoZIhvcNAQELBQAwJjEVMBMGA1UECgwMc2lnc3RvcmUuZGV2MQ0wCwYDVQQDDAR0ZXN0MB4XDTI2MDYxNTAxMDgwOFoXDTM2MDYxMjAxMDgwOFowJjEVMBMGA1UECgwMc2lnc3RvcmUuZGV2MQ0wCwYDVQQDDAR0ZXN0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvGlSlAcj9o4MUgRdEJ47mlvfnkcG+Zq+nU8IKyaSQ2PCGI7iBSVKxqMflTPJ07EAWw0psE9/MIwcVFaqmIxbcR3O1YT0qzlBMXj5VUadcO78fVAm97cUoSgTdzTZNc/oCd2Ydqb79eu0wX2be8LvQ41KdB5ppJhBEleoORM6DtLSOubgi/9G2vAJkKd6Q9trm1yG128Z+fuavkVu6ZKzqm85uiNzvXF8bsm27uXHDlkK+NB4cUlLCDnm19Q8YvK5RChLRyGBNz43BCtVs60xGfromw0lIyTPhVe7xjukPWxCYAgW/YzfC7c0FDV+26e704MiBo9hhsvEoRimikdb/QIDAQABo3cwdTBUBgNVHREETTBLhklodHRwczovL2dpdGh1Yi5jb20vdGVzdC1vcmcvLmdpdGh1Yi93b3JrZmxvd3MvcHVibGlzaC55bWxAcmVmcy9oZWFkcy9tYWluMB0GA1UdDgQWBBSCH7JkGXzTjf95sN43fHfA6JdHdTANBgkqhkiG9w0BAQsFAAOCAQEAs/nXXTAr7MVZGWQngFB1UBGUAxZX4f76CeHXp4enZKffr2DdZ5GozCJmfVZyAa8oL8DCTvYT2eWTU5g49mjMNGUpM3buSUQRHgvbc9Wb8f8zU+grh4sphKHPPnqU5d52iOY2TwocGePyvwfOJUQRPYR08Q9DLAHBNhpV0nIw/OPzUMmWkps/4g/PWbvh2U227/RlrJ8yNiiNofkqU4rNYfGCucJGmXt1DmAQimd7/NefVJMyXk4LJeFGpzzcBPhHCTyaWpoJlhH+Cuz4qCsHfj7MWiGC5JvH0Ng+5huIPuTtAq9j3fNyQZ0dGGMFpKOdz5d9+FaVSDaZ1p1gOyFlcg==";

function certBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(CERT_DER_B64, "base64"));
}

/** A verified bundle whose leaf cert is the real SAN cert (x509CertificateChain). */
function bundleWithCertChain() {
  return {
    verificationMaterial: {
      content: {
        $case: "x509CertificateChain",
        x509CertificateChain: { certificates: [{ rawBytes: certBytes() }] },
      },
      tlogEntries: [
        {
          logIndex: "42",
          logId: { keyId: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) },
          integratedTime: "1700000000",
        },
      ],
    },
  };
}

/** Same leaf cert but via the single-`certificate` content branch, no tlog. */
function bundleWithSingleCert() {
  return {
    verificationMaterial: {
      content: {
        $case: "certificate",
        certificate: { rawBytes: certBytes() },
      },
      tlogEntries: [],
    },
  };
}

function envelope(overrides: Partial<SignedManifest> = {}): SignedManifest {
  return {
    manifestChecksum: CHECKSUM,
    bundleB64: Buffer.from(JSON.stringify({ mediaType: "test" })).toString("base64"),
    metadata: {
      identity: {
        san: "https://github.com/example",
        issuer: "https://github.com/login/oauth",
        notBefore: "2026-01-01T00:00:00.000Z",
        notAfter: "2026-01-01T01:00:00.000Z",
      },
      rekorLogIndex: 123456,
      rekorLogId: "deadbeef".repeat(8),
      rekorLogUrl: "https://rekor.sigstore.dev/api/v1/log/entries?logIndex=123456",
      signedAt: "2026-01-01T00:30:00.000Z",
    },
    envelopeVersion: 1,
    ...overrides,
  };
}

describe("verifyManifestSignature — pre-crypto guards", () => {
  it("rejects an undecodable bundleB64 with envelope_invalid (JSON.parse throws)", async () => {
    // base64 of bytes that are not valid UTF-8 JSON → JSON.parse throws.
    const result = await verifyManifestSignature({
      manifestChecksum: CHECKSUM,
      signed: envelope({ bundleB64: Buffer.from("}{not json").toString("base64") }),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("envelope_invalid");
      expect(result.detail).toContain("bundle decode failed");
    }
  });
});

describe("verifyManifestSignature — requireIdentity gate", () => {
  it("rejects when requireIdentity is set but neither expectedSAN nor expectedIssuer is given", async () => {
    const result = await verifyManifestSignature({
      manifestChecksum: CHECKSUM,
      signed: envelope(),
      requireIdentity: true,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("identity_mismatch");
      expect(result.detail).toContain("requireIdentity");
    }
    // Must short-circuit before any crypto call.
    expect(sigstoreVerify).not.toHaveBeenCalled();
  });

  it("does not trip the requireIdentity guard when an expectedSAN is supplied", async () => {
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => bundleWithCertChain() as never);
    const result = await verifyManifestSignature({
      manifestChecksum: CHECKSUM,
      signed: envelope({
        metadata: {
          ...envelope().metadata,
          identity: { ...envelope().metadata.identity, san: CERT_SAN },
        },
      }),
      expectedSAN: CERT_SAN,
      requireIdentity: true,
    });
    expect(result.valid).toBe(true);
  });
});

describe("verifyManifestSignature — classifyVerifyError mapping", () => {
  const cases: Array<[string, string]> = [
    ["certificate has expired (notAfter)", "cert_expired"],
    ["rekor inclusion proof did not check out", "rekor_inclusion_failed"],
    ["certificate chain could not be built", "cert_invalid"],
    ["signature does not verify", "signature_invalid"],
    ["fetch failed: ENOTFOUND fulcio.sigstore.dev", "network_error"],
    ["something entirely unexpected happened", "unknown_error"],
  ];

  for (const [message, expectedReason] of cases) {
    it(`maps "${message}" → ${expectedReason}`, async () => {
      sigstoreVerify.mockRejectedValueOnce(new Error(message));
      const result = await verifyManifestSignature({
        manifestChecksum: CHECKSUM,
        signed: envelope(),
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe(expectedReason);
        expect(result.detail).toBe(message);
      }
    });
  }
});

describe("verifyManifestSignature — authoritative cert-derived identity (step 5)", () => {
  it("rejects cert_invalid when bundleFromJSON throws on the verified bundle", async () => {
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => {
      throw new Error("malformed protobuf");
    });
    const result = await verifyManifestSignature({
      manifestChecksum: CHECKSUM,
      signed: envelope(),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("cert_invalid");
      expect(result.detail).toContain("could not extract identity");
    }
  });

  it("rejects identity_mismatch when the VERIFIED cert SAN differs from expectedSAN", async () => {
    // Envelope's self-reported SAN is forged to match (passes the fast-fail),
    // but the real cert SAN differs → step-5 authoritative gate must reject.
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => bundleWithCertChain() as never);
    const expected = "https://github.com/trusted-org/.github/workflows/publish.yml";
    const result = await verifyManifestSignature({
      manifestChecksum: CHECKSUM,
      signed: envelope({
        metadata: {
          ...envelope().metadata,
          identity: { ...envelope().metadata.identity, san: expected },
        },
      }),
      expectedSAN: expected,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("identity_mismatch");
      expect(result.detail).toContain("verified-cert san");
      expect(result.detail).toContain(CERT_SAN);
    }
  });

  it("rejects identity_mismatch when the VERIFIED cert issuer differs from expectedIssuer", async () => {
    // The envelope issuer is forged to match expectedIssuer so the step-3
    // fast-fail passes; the real cert issuer ("sigstore.dev") differs, so the
    // step-5 authoritative gate must reject and the detail must name the cert.
    const forgedIssuer = "https://accounts.google.com";
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => bundleWithCertChain() as never);
    const result = await verifyManifestSignature({
      manifestChecksum: CHECKSUM,
      signed: envelope({
        metadata: {
          ...envelope().metadata,
          identity: {
            ...envelope().metadata.identity,
            san: CERT_SAN,
            issuer: forgedIssuer,
          },
        },
      }),
      expectedSAN: CERT_SAN,
      expectedIssuer: forgedIssuer,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("identity_mismatch");
      expect(result.detail).toContain("verified-cert issuer");
    }
  });

  it("accepts and returns the cert-derived identity when SAN and issuer pin the verified cert", async () => {
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => bundleWithCertChain() as never);
    const result = await verifyManifestSignature({
      manifestChecksum: CHECKSUM,
      signed: envelope({
        // Honest envelope that matches the cert (so the step-3 fast-fail
        // passes); the returned metadata must come from step 5's cert
        // re-derivation, including the tlog fields below.
        metadata: {
          ...envelope().metadata,
          identity: {
            ...envelope().metadata.identity,
            san: CERT_SAN,
            issuer: CERT_ISSUER,
          },
        },
      }),
      expectedSAN: CERT_SAN,
      expectedIssuer: CERT_ISSUER,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.metadata.identity.san).toBe(CERT_SAN);
      expect(result.metadata.identity.issuer).toBe(CERT_ISSUER);
      // tlog fields surfaced from the verified bundle's first entry.
      expect(result.metadata.rekorLogIndex).toBe(42);
      expect(result.metadata.rekorLogId).toBe("deadbeef");
    }
  });

  it("derives identity from the single-certificate content branch (no tlog entries)", async () => {
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => bundleWithSingleCert() as never);
    const result = await verifyManifestSignature({
      manifestChecksum: CHECKSUM,
      signed: envelope(),
      // unpinned trust-on-first-use — identity still re-derived from the cert.
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.metadata.identity.san).toBe(CERT_SAN);
      expect(result.metadata.identity.issuer).toBe(CERT_ISSUER);
      // No tlog entries → logIndex falls back to 0.
      expect(result.metadata.rekorLogIndex).toBe(0);
      expect(result.metadata.rekorLogId).toBe("");
    }
  });
});
