# AgentPack signatures — Sigstore keyless

AgentPack signs the `manifestChecksum` of every published pack via Sigstore keyless flow. There is no long-lived signing key to rotate, leak, or store. The signature commits to **your OIDC identity at signing time** (typically your GitHub account) for ~10 minutes, and Rekor's transparency log makes that commitment tamper-evident forever after.

This page is the one-paragraph "what is trusted" doc that `--require-sig` is unusable without.

## What gets signed

The signed payload is the **lowercase hex SHA-256 of the raw `AGENTPACK.yaml` bytes**, encoded as UTF-8. That's it. Atom files are protected by per-file SHA-256 entries in `AGENTPACK.lock` (Phase 2); the lockfile checksum is what the signature pins. Verify drift + verify signature together = the bytes you install match the bytes the publisher signed.

## Trust roots

By default AgentPack trusts the **public Sigstore production trusted root** (Fulcio CA + Rekor log) maintained by the OpenSSF Sigstore project. This is the same trust root npm, PyPI, and Homebrew use for keyless attestations. No custom CA. No PAI-managed key material.

A "trusted signature" means **all four** of these check out:

1. **Cert chain** — the leaf cert was issued by Fulcio's CA.
2. **Signature** — cosign-verified over the manifest hash bytes.
3. **Rekor inclusion** — there is a transparency log entry binding the cert + signature + manifest hash at a specific log index.
4. **Identity** (optional gate) — the cert's SAN URI matches an expected publisher identity, if one is pinned.

## Three-state verify error taxonomy

The CLI distinguishes three failure modes (advisor-recommended; conflating these is the #1 UX bug in signing rollouts):

| State | What happened | Exit code |
|-------|---------------|-----------|
| `unsigned` | The lockfile (or registry) has no signature for this version | 5 |
| `signature invalid` | A signature exists but verification failed (bad sig, bad cert, bad Rekor proof) | 4 |
| `identity_mismatch` | Signature is cryptographically valid but the SAN/issuer doesn't match an expected identity | 4 |

Plus the Phase 2 baseline: `0` clean, `2` drift, `3` history chain broken.

## Signing locally

You need an OIDC token. The simplest path:

```bash
# Use a GitHub Personal Access Token. AgentPack only ever uses it to obtain
# a short-lived Sigstore cert — it is never sent to the registry.
export SIGSTORE_ID_TOKEN="$(gh auth token)"
workgraph publish ./AGENTPACK.yaml --registry https://registry.workgraph.dev
```

When `--sign` is in effect (the default), the CLI:

1. Computes the manifest SHA-256.
2. Hits Fulcio with your OIDC token → receives a short-lived cert bound to your GitHub identity.
3. Signs the manifest hash with the cert's ephemeral private key.
4. Logs the signature + cert to Rekor.
5. Sends the bundle to the registry along with the version row insert.

Pass `--no-sign` to opt out; the registry will store the version row as unsigned and the badge will read "Unsigned".

## Signing from CI

GitHub Actions provides ambient OIDC tokens for free. Replace the `gh auth token` line with the standard Sigstore env vars in your workflow — `@sigstore/sign`'s `CIContextProvider` picks them up automatically:

```yaml
permissions:
  id-token: write   # required for OIDC
  contents: read
jobs:
  publish:
    steps:
      - uses: actions/checkout@v4
      - run: pnpm workgraph publish ./AGENTPACK.yaml --registry https://registry.workgraph.dev
```

The signature's identity claim will be the workflow URI, e.g. `https://github.com/<owner>/<repo>/.github/workflows/<wf>.yml@<ref>`.

## Verifying

Two layers:

```bash
# Verify drift only (Phase 2 baseline).
workgraph verify <packId>

# Verify drift AND Sigstore signature (Phase 4).
workgraph verify <packId> --sig

# Same, but refuse if unsigned.
workgraph verify <packId> --sig --strict
```

For remote installs:

```bash
# Refuse to install if the registry has no valid signature for this version.
workgraph install workgraph/pr-quality@0.1.0 --require-sig
```

The CLI's `--require-sig` flag is the enforcement primitive — without it, signing is decorative. Use it in CI pipelines and production install scripts.

## Offline verification

Once a pack is installed with a valid signature, `workgraph verify --sig` is **mostly offline**: it decodes the lockfile-embedded bundle, checks the cert chain against Sigstore's bundled trusted root (no network), checks the signature math (no network), and — by default — also reaches out to Rekor to confirm the inclusion proof.

Pass `--offline` to `signing.verifyManifestSignature` (programmatic) to skip the Rekor check entirely. This is appropriate when the lockfile is being verified in an air-gapped environment that has already seen the Rekor proof bundled in. CLI flag exposure for `--offline` is coming in v0.4.1.

## Signature format stability

The `signatures.manifest` lockfile slot stores a base64-encoded JSON envelope:

```json
{
  "manifestChecksum": "<64-char hex>",
  "bundleB64": "<base64 of Sigstore Bundle JSON>",
  "metadata": {
    "identity": { "san": "...", "issuer": "...", "notBefore": "...", "notAfter": "..." },
    "rekorLogIndex": 123456,
    "rekorLogId": "...",
    "rekorLogUrl": "https://rekor.sigstore.dev/api/v1/log/entries?logIndex=123456",
    "signedAt": "..."
  },
  "envelopeVersion": 1
}
```

`envelopeVersion: 1` is stable as of v0.4.0. Any future change to the envelope shape will bump this integer; verifiers will accept old versions for as long as they remain interoperable, then refuse with a clear migration message.

## Revocation

There is no "revoke" button. The Sigstore model is:

1. **Signature is permanent.** A signed pack stays signed; the signature commits to "publisher X had this manifest at time T."
2. **Yank to deprecate.** The publisher can mark a version `yanked` on the registry; the CLI warns on install but doesn't refuse.
3. **Quarantine to block.** The registry admin can mark a version `quarantined`; the CLI refuses to install unless `--allow-quarantined` is passed.
4. **Re-sign to recover.** If a signature is suspected compromised (rare with keyless — the cert was only valid for ~10 minutes), the publisher re-signs the version. The newest signature row is what the badge displays.

Compromise runbook (v0.4.0):

- Yank affected versions.
- File a registry-admin request to quarantine if the impact warrants it.
- Re-sign clean versions from a fresh OIDC session.
- Publish a new minor with a documented incident note.

A formal incident-response playbook is on the roadmap for v0.4.x.

## Why keyless and not publisher-managed keys?

- **Rotation is solved.** Cert lives ~10 minutes; nothing to rotate.
- **Loss is solved.** No long-lived secret can be lost.
- **Identity is the trust anchor**, not key material. Users trust "@you signed this" — not "this specific key signed this." When @you rotates IdP credentials, signatures still verify.
- **Compatibility.** Same model as npm provenance (GA July 2025) and PyPI Trusted Publishing — users already know the mental model.

Publisher-managed long-lived keys are a Phase 6.5 enterprise option, gated on customer demand. See `Plans/PHASE-6-GATE.md`.
