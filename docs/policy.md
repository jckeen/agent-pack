# `workgraph.policy.json` — install policy

A project-level guardrail. When present, the CLI loads it on every install (and
verify) and refuses to proceed if any rule is violated.

This document is the reference. The wire shape is pinned in `Plans/PROTOCOL.md` § 7;
the zod schema lives in `packages/core/src/policy/schema.ts`.

---

## Quickstart

```json
{
  "policyVersion": 1,
  "registries": {
    "allowed": ["https://registry.workgraph.dev"],
    "default": "https://registry.workgraph.dev"
  },
  "packs": {
    "allowedPublishers": ["workgraph", "acme"],
    "blockedPacks": ["evil-corp/sketchy-pack"]
  },
  "install": {
    "requireSignature": true,
    "allowedProfiles": ["safe", "standard"],
    "deniedAtomTypes": ["hook"]
  },
  "verify": {
    "onInstall": "warn",
    "chain": "warn"
  }
}
```

Place this file at the project root (next to `package.json` /  `AGENTPACK.yaml`).
**Not** under `.workgraph/` — like `.editorconfig` it is user-authored, hand-edited,
and meant to be committed.

---

## Schema (v1)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `policyVersion` | `1` (literal) | required | Schema version. v2 will arrive when Phase 6 org-policy lands. |
| `registries.allowed` | `string[]` (URLs) | `[]` | Whitelist; empty = no constraint. |
| `registries.default` | `string` (URL) | none | Used when `--registry` isn't passed. |
| `packs.allowedPublishers` | `string[]` (slugs) | none | Whitelist publishers. |
| `packs.blockedPacks` | `string[]` (`pub/pack` or full ID) | none | Hard blocklist. |
| `install.requireSignature` | `boolean` | `false` | Reject packs with no cosign signature (Phase 4-ready; currently always rejects until Phase 4 lands). |
| `install.allowedProfiles` | `ProfileName[]` | none | Restrict installable profiles. |
| `install.deniedAtomTypes` | `AtomType[]` | none | Reject plans containing any of these atom types. |
| `verify.onInstall` | `off \| warn \| required` | none | Run `workgraph verify` after install. Reserved for Phase 4 wiring. |
| `verify.chain` | `off \| warn \| required` | none | Run `workgraph verify --chain` after install. Reserved. |

---

## Enforcement order

`enforcePolicy(policy, plan, registryUrl)` returns **all** violations at once
(not just the first), so the user gets a complete picture in one shot. Order:

1. **Registry allowlist** — if `registries.allowed` is non-empty and the active registry isn't in it. Code: `registry`.
2. **Publisher allowlist** — if `packs.allowedPublishers` is non-empty and the pack's publisher isn't in it. Code: `publisher`.
3. **Blocked packs** — if the pack ID is in `packs.blockedPacks`. Code: `blockedPack`.
4. **Signature requirement** — if `install.requireSignature: true` and the lockfile's `signatures.manifest` is empty. Code: `unsigned`.
5. **Profile allowlist** — if `install.allowedProfiles` is non-empty and the chosen profile isn't in it. Code: `profile`.
6. **Denied atom types** — if any atom in the plan has a type in `install.deniedAtomTypes`. Code: `atomType`.

Each violation has a human `message` and an optional `hint`. The CLI prints
them all then exits **6** (`ExitCode.PolicyViolation`).

---

## Example: dev sandbox

```json
{
  "policyVersion": 1,
  "registries": { "allowed": [], "default": "https://registry.workgraph.dev" },
  "packs": {},
  "install": { "allowedProfiles": ["safe"] }
}
```

"I'm playing with packs but never above the `safe` profile." Hooks, MCP, etc.
all stay off.

## Example: corporate strict

```json
{
  "policyVersion": 1,
  "registries": {
    "allowed": ["https://registry.workgraph.dev", "https://internal.acme.example.com"],
    "default": "https://internal.acme.example.com"
  },
  "packs": { "allowedPublishers": ["acme", "workgraph"] },
  "install": {
    "requireSignature": true,
    "allowedProfiles": ["safe", "standard"],
    "deniedAtomTypes": ["hook"]
  }
}
```

Three constraints stacked: only the company's internal mirror + the canonical
one, only two trusted publishers, signed-only, max-profile-standard, no
shell-execution hooks.

---

## What policy does NOT do (yet)

- **Org-managed central policy.** Phase 6 adds `/api/orgs/<slug>/policy` and an
  org-policy overlay; until then, every project carries its own file.
- **OPA/Rego DSL.** Phase 6.5+. Declarative JSON covers ~80% of policy needs
  today; if/then logic over pack metadata waits.
- **Audit log of policy decisions.** Phase 6 enterprise; the registry's
  `audit_events` table reserves the slot.

See `Plans/ROADMAP.md` for the revisit triggers.
