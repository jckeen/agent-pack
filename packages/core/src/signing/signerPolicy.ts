/**
 * Signer-identity gate — the trust decision applied AFTER a manifest signature
 * is found cryptographically valid.
 *
 * A valid Sigstore keyless signature only proves "some GitHub (or other OIDC)
 * identity signed this manifest" — not that the *expected* publisher did. An
 * attacker who tampers with a pack can re-sign it with their own identity and
 * still produce a cryptographically valid bundle (ISC-289). Closing that gap
 * means pinning the acceptable signer identity (SAN) and refusing anything
 * else.
 *
 * This function is the single source of truth for that decision, shared by
 * `agentpack install --require-sig` and `agentpack verify --sig`. Pin sources,
 * unioned:
 *   - `--expected-signer <san>` on the CLI (per-invocation pin)
 *   - `install.allowedSigners` in `agentpack.policy.json` (org-wide allowlist —
 *     the governance-layer answer; the registry-side per-publisher allowlist is
 *     a later enhancement that needs the live registry to serve a bound SAN)
 *
 * When `requireIdentity` is set (policy `install.requireIdentity`) but no pin
 * is configured, an unpinned-but-valid signature is REFUSED rather than
 * accepted on trust-on-first-use — "I asked for a signature" should not
 * silently mean "any identity will do."
 */

export interface SignerGateInput {
  /** The cryptographically-verified signer SAN from the signature bundle. */
  signerSan: string;
  /** `--expected-signer <san>`, if passed. */
  expectedSigner?: string | undefined;
  /** `install.allowedSigners` from policy, if configured. */
  allowedSigners?: readonly string[] | undefined;
  /** `install.requireIdentity` from policy (refuse unpinned signatures). */
  requireIdentity?: boolean | undefined;
}

export type SignerGateResult =
  | { ok: true; mode: "pinned" | "tofu"; signerSan: string }
  | {
      ok: false;
      reason: "identity_mismatch" | "identity_required";
      signerSan: string;
      allowed: string[];
    };

/**
 * Decide whether a cryptographically-valid signature clears the identity bar.
 *
 *   - A non-empty pin set (CLI `--expected-signer` ∪ policy `allowedSigners`)
 *     means the signer SAN must be a member → `pinned`, else `identity_mismatch`.
 *   - An empty pin set with `requireIdentity` → `identity_required` (refuse).
 *   - An empty pin set without `requireIdentity` → `tofu` (accept on trust,
 *     caller should warn that the identity is unpinned).
 */
export function evaluateSignerGate(input: SignerGateInput): SignerGateResult {
  const { signerSan, expectedSigner, allowedSigners, requireIdentity } = input;
  const allowed = [...(expectedSigner ? [expectedSigner] : []), ...(allowedSigners ?? [])]
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unique = [...new Set(allowed)];

  if (unique.length > 0) {
    return unique.includes(signerSan)
      ? { ok: true, mode: "pinned", signerSan }
      : { ok: false, reason: "identity_mismatch", signerSan, allowed: unique };
  }
  if (requireIdentity) {
    return { ok: false, reason: "identity_required", signerSan, allowed: [] };
  }
  return { ok: true, mode: "tofu", signerSan };
}
