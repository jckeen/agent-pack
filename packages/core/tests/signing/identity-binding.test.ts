import { describe, expect, it, vi } from "vitest";

/**
 * ISC-289 / security-reviewer CRITICAL-1 (iter-9).
 *
 * A valid Sigstore keyless signature only proves *some* Fulcio identity signed
 * the manifest checksum. The signer identity must therefore be read from the
 * certificate INSIDE the cryptographically-verified bundle — never from
 * `envelope.metadata.identity.san`, which is plain JSON an attacker can edit.
 *
 * These tests pin that contract by mocking the two boundaries:
 *   - `sigstore.verify` resolves (simulating a cryptographically-valid bundle —
 *     a real bundle can't be produced offline; that's the deferred live-CI
 *     round-trip).
 *   - `@sigstore/bundle.bundleFromJSON` returns a bundle whose verification
 *     material has no recognized X.509 cert chain, so the production
 *     `extractMetadata` derives the SAN `"unknown"`.
 *
 * The envelope's `metadata.identity.san` is then *forged* to a trusted value.
 * If the gate judged the envelope, it would pass; because it judges the
 * cert-derived SAN (`"unknown"`), it must reject — and the returned metadata
 * must be the cert-derived one, never the forged envelope value.
 */

vi.mock("sigstore", () => ({
  verify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@sigstore/bundle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sigstore/bundle")>();
  return {
    ...actual,
    // A verified bundle with no x509 cert chain → extractMetadata() → san "unknown".
    bundleFromJSON: vi.fn(() => ({
      verificationMaterial: {
        content: { $case: "publicKey" },
        tlogEntries: [],
      },
    })),
  };
});

import { verifyManifestSignature } from "../../src/signing/sigstore.js";
import type { SignedManifest } from "../../src/signing/types.js";

const CHECKSUM = "a".repeat(64);

function envelopeWithSan(san: string): SignedManifest {
  return {
    manifestChecksum: CHECKSUM,
    bundleB64: Buffer.from(JSON.stringify({ mediaType: "test" })).toString("base64"),
    metadata: {
      identity: {
        san,
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
  };
}

describe("verifyManifestSignature — identity bound to the verified certificate (ISC-289)", () => {
  const VICTIM = "https://github.com/trusted-org/.github/workflows/publish.yml";

  it("rejects a valid bundle whose envelope SAN is forged to the expected value but whose cert SAN differs", async () => {
    // Attacker re-signs tampered content with their own identity (verify
    // passes), then edits the envelope SAN to impersonate the victim so the
    // early fast-fail and the pin both see a 'match'.
    const result = await verifyManifestSignature({
      manifestChecksum: CHECKSUM,
      signed: envelopeWithSan(VICTIM),
      expectedSAN: VICTIM,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("identity_mismatch");
      // The detail must reference the VERIFIED cert, proving it's the
      // cert-derived SAN ("unknown") that was judged, not the forged envelope.
      expect(result.detail).toContain("verified-cert");
    }
  });

  it("returns the cert-derived identity, never the envelope's forged claim, on success", async () => {
    const result = await verifyManifestSignature({
      manifestChecksum: CHECKSUM,
      signed: envelopeWithSan("https://github.com/EVIL-forged-claim"),
      // unpinned — trust-on-first-use; no SAN comparison, but the returned
      // identity must still come from the verified cert.
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.metadata.identity.san).toBe("unknown");
      expect(result.metadata.identity.san).not.toBe("https://github.com/EVIL-forged-claim");
    }
  });
});
