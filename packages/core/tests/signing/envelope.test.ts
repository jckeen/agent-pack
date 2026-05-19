/**
 * Phase 4 — signing envelope schema tests.
 *
 * These tests cover the offline-verifiable surface — schema parsing,
 * base64 round-trip, identity-gate failures. Live Fulcio/Rekor calls are
 * NOT exercised here (they require OIDC token + network), but those
 * paths are routed through the same envelope, so a green envelope test
 * suite catches the bulk of regressions.
 */

import { describe, expect, it } from "vitest";

import { signing } from "../../src/index.js";

const VALID_HEX_SHA256 = "a".repeat(64);

const VALID_ENVELOPE: signing.SignedManifest = {
  manifestChecksum: VALID_HEX_SHA256,
  bundleB64: Buffer.from(JSON.stringify({ mediaType: "test" })).toString(
    "base64"
  ),
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
};

describe("signedManifestSchema", () => {
  it("accepts a well-formed envelope", () => {
    expect(() => signing.signedManifestSchema.parse(VALID_ENVELOPE)).not.toThrow();
  });

  it("rejects a non-hex manifest checksum", () => {
    expect(() =>
      signing.signedManifestSchema.parse({
        ...VALID_ENVELOPE,
        manifestChecksum: "not-hex",
      })
    ).toThrow();
  });

  it("rejects a short manifest checksum", () => {
    expect(() =>
      signing.signedManifestSchema.parse({
        ...VALID_ENVELOPE,
        manifestChecksum: "a".repeat(63),
      })
    ).toThrow();
  });

  it("rejects an empty bundleB64", () => {
    expect(() =>
      signing.signedManifestSchema.parse({ ...VALID_ENVELOPE, bundleB64: "" })
    ).toThrow();
  });

  it("defaults envelopeVersion to 1 when omitted", () => {
    const { envelopeVersion: _omit, ...rest } = VALID_ENVELOPE;
    void _omit;
    const parsed = signing.signedManifestSchema.parse(rest);
    expect(parsed.envelopeVersion).toBe(1);
  });

  it("rejects negative rekorLogIndex", () => {
    expect(() =>
      signing.signedManifestSchema.parse({
        ...VALID_ENVELOPE,
        metadata: { ...VALID_ENVELOPE.metadata, rekorLogIndex: -1 },
      })
    ).toThrow();
  });

  it("rejects malformed rekorLogUrl", () => {
    expect(() =>
      signing.signedManifestSchema.parse({
        ...VALID_ENVELOPE,
        metadata: { ...VALID_ENVELOPE.metadata, rekorLogUrl: "not-a-url" },
      })
    ).toThrow();
  });
});

describe("verifyManifestSignature — offline failure modes", () => {
  it("returns envelope_invalid for malformed input", async () => {
    const result = await signing.verifyManifestSignature({
      manifestChecksum: VALID_HEX_SHA256,
      // @ts-expect-error — intentionally wrong shape
      signed: { manifestChecksum: "no" },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("envelope_invalid");
  });

  it("returns checksum_mismatch when observed differs from signed", async () => {
    const result = await signing.verifyManifestSignature({
      manifestChecksum: "b".repeat(64),
      signed: VALID_ENVELOPE,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("checksum_mismatch");
  });

  it("returns identity_mismatch when expected SAN differs", async () => {
    const result = await signing.verifyManifestSignature({
      manifestChecksum: VALID_HEX_SHA256,
      signed: VALID_ENVELOPE,
      expectedSAN: "https://github.com/someone-else",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("identity_mismatch");
  });

  it("returns identity_mismatch when expected issuer differs", async () => {
    const result = await signing.verifyManifestSignature({
      manifestChecksum: VALID_HEX_SHA256,
      signed: VALID_ENVELOPE,
      expectedIssuer: "https://accounts.google.com",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("identity_mismatch");
  });
});

describe("base64 round-trip", () => {
  it("encodes and decodes a bundle JSON cleanly", () => {
    const bundle = { mediaType: "test", verificationMaterial: {} };
    const b64 = Buffer.from(JSON.stringify(bundle), "utf-8").toString("base64");
    const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    expect(decoded).toEqual(bundle);
  });
});
