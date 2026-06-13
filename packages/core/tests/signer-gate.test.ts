import { describe, expect, it } from "vitest";

import { evaluateSignerGate } from "../src/signing/signerPolicy.js";
import { policyConfigSchema } from "../src/policy/schema.js";

/**
 * ISC-289: a cryptographically-valid Sigstore signature only proves *some*
 * identity signed the manifest, not that the expected publisher did. The
 * signer gate is the trust decision layered on top — pinning the acceptable
 * signer from `--expected-signer` ∪ policy `install.allowedSigners`, and
 * refusing an unpinned signer when policy `install.requireIdentity` is set.
 */
describe("evaluateSignerGate", () => {
  const SAN = "https://github.com/acme/.github/.../publish.yml@refs/tags/v1";

  it("accepts an unpinned signer as trust-on-first-use when nothing requires identity", () => {
    const r = evaluateSignerGate({ signerSan: SAN });
    expect(r).toEqual({ ok: true, mode: "tofu", signerSan: SAN });
  });

  it("pins via --expected-signer when the SAN matches", () => {
    const r = evaluateSignerGate({ signerSan: SAN, expectedSigner: SAN });
    expect(r).toEqual({ ok: true, mode: "pinned", signerSan: SAN });
  });

  it("rejects an identity mismatch against --expected-signer", () => {
    const r = evaluateSignerGate({
      signerSan: SAN,
      expectedSigner: "https://github.com/evil/x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("identity_mismatch");
      expect(r.allowed).toEqual(["https://github.com/evil/x"]);
    }
  });

  it("pins via the policy allowlist (any member matches)", () => {
    const r = evaluateSignerGate({
      signerSan: SAN,
      allowedSigners: ["https://github.com/other/y", SAN],
    });
    expect(r).toEqual({ ok: true, mode: "pinned", signerSan: SAN });
  });

  it("rejects a signer absent from the policy allowlist", () => {
    const r = evaluateSignerGate({
      signerSan: SAN,
      allowedSigners: ["https://github.com/other/y"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("identity_mismatch");
  });

  it("unions --expected-signer and policy allowlist, de-duped", () => {
    const r = evaluateSignerGate({
      signerSan: SAN,
      expectedSigner: SAN,
      allowedSigners: [SAN, "https://github.com/other/y"],
    });
    expect(r).toEqual({ ok: true, mode: "pinned", signerSan: SAN });
  });

  it("refuses an unpinned-but-valid signer when requireIdentity is set", () => {
    const r = evaluateSignerGate({ signerSan: SAN, requireIdentity: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("identity_required");
      expect(r.allowed).toEqual([]);
    }
  });

  it("requireIdentity is satisfied once a matching pin is configured", () => {
    const r = evaluateSignerGate({
      signerSan: SAN,
      allowedSigners: [SAN],
      requireIdentity: true,
    });
    expect(r).toEqual({ ok: true, mode: "pinned", signerSan: SAN });
  });

  it("ignores blank / whitespace-only pins", () => {
    const r = evaluateSignerGate({
      signerSan: SAN,
      expectedSigner: "   ",
      allowedSigners: ["", "  "],
    });
    expect(r).toEqual({ ok: true, mode: "tofu", signerSan: SAN });
  });
});

describe("policy schema — signer governance fields (ISC-289)", () => {
  it("parses install.allowedSigners and install.requireIdentity", () => {
    const parsed = policyConfigSchema.parse({
      policyVersion: 1,
      install: {
        requireIdentity: true,
        allowedSigners: ["https://github.com/acme/x"],
      },
    });
    expect(parsed.install.requireIdentity).toBe(true);
    expect(parsed.install.allowedSigners).toEqual(["https://github.com/acme/x"]);
  });

  it("leaves the new fields undefined when omitted (back-compat)", () => {
    const parsed = policyConfigSchema.parse({ policyVersion: 1 });
    expect(parsed.install.allowedSigners).toBeUndefined();
    expect(parsed.install.requireIdentity).toBeUndefined();
  });
});
