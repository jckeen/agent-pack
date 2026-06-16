/**
 * Issue #35 — verifyReleaseSignature: the full-artifact trust gate.
 *
 * Mocks the two crypto boundaries the same way sigstore-verify.test.ts does:
 *   - `sigstore.verify` resolving simulates a cryptographically-valid bundle.
 *   - `@sigstore/bundle.bundleFromJSON` controls the cert identity step 5
 *     re-derives.
 *
 * The new behavior under test: a v2 envelope embeds a release descriptor; the
 * signed payload is the descriptor digest. Verification must (a) confirm the
 * embedded descriptor's manifestSha256 matches what we observed, and (b) check
 * downloaded files against the SIGNED descriptor, rejecting a swapped file even
 * when the registry would have served a matching (malicious) per-file hash.
 */

import { describe, expect, it, vi } from "vitest";

const sigstoreVerify = vi.fn().mockResolvedValue(undefined);

vi.mock("sigstore", () => ({ verify: sigstoreVerify }));

vi.mock("@sigstore/bundle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sigstore/bundle")>();
  return {
    ...actual,
    bundleFromJSON: vi.fn(() => ({
      verificationMaterial: {
        content: { $case: "publicKey" },
        tlogEntries: [],
      },
    })),
  };
});

import { bundleFromJSON } from "@sigstore/bundle";

import {
  buildReleaseDescriptor,
  canonicalReleaseDigest,
} from "../../src/signing/releaseDescriptor.js";
import { verifyReleaseSignature } from "../../src/signing/sigstore.js";
import type { SignedManifest } from "../../src/signing/types.js";

const MANIFEST_SHA = "a".repeat(64);
const HASH_A = "1".repeat(64);
const HASH_B = "2".repeat(64);

const CERT_SAN =
  "https://github.com/test-org/.github/workflows/publish.yml@refs/heads/main";
const CERT_DER_B64 =
  "MIIDUTCCAjmgAwIBAgIUZXaSUzE7o9iB1DWs6+26MFBfYSQwDQYJKoZIhvcNAQELBQAwJjEVMBMGA1UECgwMc2lnc3RvcmUuZGV2MQ0wCwYDVQQDDAR0ZXN0MB4XDTI2MDYxNTAxMDgwOFoXDTM2MDYxMjAxMDgwOFowJjEVMBMGA1UECgwMc2lnc3RvcmUuZGV2MQ0wCwYDVQQDDAR0ZXN0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvGlSlAcj9o4MUgRdEJ47mlvfnkcG+Zq+nU8IKyaSQ2PCGI7iBSVKxqMflTPJ07EAWw0psE9/MIwcVFaqmIxbcR3O1YT0qzlBMXj5VUadcO78fVAm97cUoSgTdzTZNc/oCd2Ydqb79eu0wX2be8LvQ41KdB5ppJhBEleoORM6DtLSOubgi/9G2vAJkKd6Q9trm1yG128Z+fuavkVu6ZKzqm85uiNzvXF8bsm27uXHDlkK+NB4cUlLCDnm19Q8YvK5RChLRyGBNz43BCtVs60xGfromw0lIyTPhVe7xjukPWxCYAgW/YzfC7c0FDV+26e704MiBo9hhsvEoRimikdb/QIDAQABo3cwdTBUBgNVHREETTBLhklodHRwczovL2dpdGh1Yi5jb20vdGVzdC1vcmcvLmdpdGh1Yi93b3JrZmxvd3MvcHVibGlzaC55bWxAcmVmcy9oZWFkcy9tYWluMB0GA1UdDgQWBBSCH7JkGXzTjf95sN43fHfA6JdHdTANBgkqhkiG9w0BAQsFAAOCAQEAs/nXXTAr7MVZGWQngFB1UBGUAxZX4f76CeHXp4enZKffr2DdZ5GozCJmfVZyAa8oL8DCTvYT2eWTU5g49mjMNGUpM3buSUQRHgvbc9Wb8f8zU+grh4sphKHPPnqU5d52iOY2TwocGePyvwfOJUQRPYR08Q9DLAHBNhpV0nIw/OPzUMmWkps/4g/PWbvh2U227/RlrJ8yNiiNofkqU4rNYfGCucJGmXt1DmAQimd7/NefVJMyXk4LJeFGpzzcBPhHCTyaWpoJlhH+Cuz4qCsHfj7MWiGC5JvH0Ng+5huIPuTtAq9j3fNyQZ0dGGMFpKOdz5d9+FaVSDaZ1p1gOyFlcg==";

function certBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(CERT_DER_B64, "base64"));
}

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

const FILES = [
  { path: "a.md", sha256: HASH_A, bytes: 1, atomId: "atom-a" },
  { path: "b.md", sha256: HASH_B, bytes: 2, atomId: "atom-b" },
];

function v2Envelope(overrides: Partial<SignedManifest> = {}): SignedManifest {
  const descriptor = buildReleaseDescriptor({
    manifestSha256: MANIFEST_SHA,
    files: FILES,
  });
  return {
    manifestChecksum: MANIFEST_SHA,
    releaseDescriptor: descriptor,
    bundleB64: Buffer.from(JSON.stringify({ mediaType: "test" })).toString("base64"),
    metadata: {
      identity: {
        san: CERT_SAN,
        issuer: "sigstore.dev",
        notBefore: "2026-01-01T00:00:00.000Z",
        notAfter: "2026-01-01T01:00:00.000Z",
      },
      rekorLogIndex: 42,
      rekorLogId: "deadbeef",
      rekorLogUrl: "https://rekor.sigstore.dev/api/v1/log/entries?logIndex=42",
      signedAt: "2026-01-01T00:30:00.000Z",
    },
    envelopeVersion: 2,
    ...overrides,
  };
}

describe("verifyReleaseSignature — full-artifact coverage", () => {
  it("signs the descriptor digest: sigstore.verify is called with the release digest", async () => {
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => bundleWithCertChain() as never);
    const env = v2Envelope();
    const digest = canonicalReleaseDigest(env.releaseDescriptor!);
    await verifyReleaseSignature({
      manifestSha256: MANIFEST_SHA,
      observedFiles: FILES.map((f) => ({ path: f.path, sha256: f.sha256 })),
      signed: env,
    });
    const lastCall = sigstoreVerify.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    expect((lastCall![1] as Buffer).toString("utf-8")).toBe(digest);
  });

  it("accepts when all observed files match the signed descriptor", async () => {
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => bundleWithCertChain() as never);
    const result = await verifyReleaseSignature({
      manifestSha256: MANIFEST_SHA,
      observedFiles: FILES.map((f) => ({ path: f.path, sha256: f.sha256 })),
      signed: v2Envelope(),
    });
    expect(result.valid).toBe(true);
  });

  it("REJECTS a swapped atom file even when the registry-served per-file hash matched", async () => {
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => bundleWithCertChain() as never);
    const result = await verifyReleaseSignature({
      manifestSha256: MANIFEST_SHA,
      // The bytes actually on disk hash to HASH_B for a.md — a swap. The
      // signed descriptor still pins HASH_A, so this must fail.
      observedFiles: [
        { path: "a.md", sha256: HASH_B },
        { path: "b.md", sha256: HASH_B },
      ],
      signed: v2Envelope(),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("artifact_mismatch");
      expect(result.detail).toContain("a.md");
    }
  });

  it("rejects when the embedded descriptor's manifestSha256 differs from observed", async () => {
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => bundleWithCertChain() as never);
    const result = await verifyReleaseSignature({
      manifestSha256: "c".repeat(64),
      observedFiles: FILES.map((f) => ({ path: f.path, sha256: f.sha256 })),
      signed: v2Envelope(),
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("checksum_mismatch");
    }
  });

  it("treats a v1 (manifest-only) envelope as legacy/partial coverage", async () => {
    vi.mocked(bundleFromJSON).mockImplementationOnce(() => bundleWithCertChain() as never);
    const legacy: SignedManifest = {
      manifestChecksum: MANIFEST_SHA,
      bundleB64: Buffer.from(JSON.stringify({ mediaType: "test" })).toString("base64"),
      metadata: v2Envelope().metadata,
      envelopeVersion: 1,
    };
    const result = await verifyReleaseSignature({
      manifestSha256: MANIFEST_SHA,
      observedFiles: FILES.map((f) => ({ path: f.path, sha256: f.sha256 })),
      signed: legacy,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.coverage).toBe("manifest-only");
    }
  });
});
