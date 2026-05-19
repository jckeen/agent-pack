# Phase 6 — Deferral Gate

**Status: 🔒 Gated — implementation will not start until the trigger condition fires.**

AgentPack is open source. Its **registry**, **CLI**, **standard**, and **adapters** are MIT-licensed and remain free forever. Phase 6 is not where we make the project paid — Phase 6 is where the **hosted enterprise registry** at `agentpack.dev` (and self-host packages) grow first-class organization boundaries, central policy, and audit trails. The work has real cost (touches every surface — auth, DB schema, CLI, registry UI, billing-adjacent code) and the biggest "got it wrong" tax (enterprise contracts have long memories), so we don't pay it speculatively.

## Trigger condition

> **The first paying-customer conversation about enterprise self-host.**

Concretely, any one of these qualifies:

| Qualifier | What it is | Why it counts |
|-----------|------------|---------------|
| A signed Letter of Intent or PO from an org wanting hosted enterprise | Real money committed | Highest-grade signal |
| A scheduled procurement call with a Fortune 1000 security/platform team | They're already past "is this a thing?" | They're going to ask the 8 questions below; we'd better have answers |
| Three or more inbound inquiries within 14 days asking explicitly about SSO, audit log export, or org-scoped publishing | Demand has crossed the noise floor | We're past the curiosity bar |
| One platform team commits to a paid pilot via DM/email with an internal champion identified | Champion + budget = the real unlock | More predictive than a fortune-of-leads pipeline |

Curiosity-grade pings ("does it have SSO?" with no follow-up) do **not** trigger. Real demand has shape: a person, a timeline, a budget, a concrete usage story.

## What we are NOT doing while gated

- No `orgs` table migration runs in production. (Schema slot reserved — see "schema continuity" below — but no live ALTER TABLE.)
- No WorkOS account is provisioned.
- No org-admin UI is built.
- No audit-event row writes are wired up. (Table exists, but every state-mutating route in the registry currently writes nothing to `audit_events`.)
- No org-scoped publish flow in CLI.
- No billing system, Stripe webhooks, plan logic, seat limits, anything billing-adjacent.

## What stays valid while gated

The Phase 3+5 scaffold quietly preserved Phase 6's schema shape so that flipping the gate is **a migration, not a re-architecture**:

| Phase 6 surface | What's already in place | What's still owed at gate-flip |
|-----------------|-------------------------|-------------------------------|
| Org-scoped publishers | `publishers.org_id` is nullable, no FK enforced yet | Add FK constraint + backfill personal publishers to org_id null permanently |
| Audit events | `audit_events` table exists, hash-chain primitive (`previous_entry_id`, `entry_checksum`) borrows Phase 2's `history.jsonl` shape | Wire writes from every state-mutating route; expose `GET /api/orgs/<slug>/audit?since=…` |
| User identity | NextAuth v5 with GitHub OAuth | Add WorkOS provider alongside GitHub; org binding via Directory Sync claim |
| Policy fetch | CLI already reads `agentpack.policy.json` locally (Phase 5) | Add `GET /api/orgs/<slug>/policy` server route + CLI fallback chain |

## The 8 decisions to revisit when triggered

Each is roadmapped in `Plans/ROADMAP.md` § Phase 6. The gate revisits them — does not re-pin them — because the trigger event will provide concrete constraints (customer's IdP, customer's compliance regime, customer's seat shape) that current speculation cannot.

| # | Decision | Currently pinned to | Likely revision when triggered |
|---|----------|--------------------|--------------------------------|
| 1 | Org/workspace model | Single-tenant SaaS first; OSS self-host as Phase 6.5 | Customer may demand self-host on day one — pull Phase 6.5 forward |
| 2 | SSO provider | WorkOS | Confirm customer's IdP works (Okta/Azure AD/Google Workspace all WorkOS-supported); pin pricing tier |
| 3 | Audit-event chain | Per-org hash chain reusing Phase 2 primitive | Confirm export format (JSON Lines stream? S3 dump?) and retention (90 days? indefinite?) |
| 4 | Policy-as-code DSL | Declarative JSON (extends `agentpack.policy.json` v1) | If customer's policy needs > declarative, accelerate OPA/Rego (Phase 6.5+) |
| 5 | Billing model | Defer — open source has no billing surface today | Decide seat-based vs usage-based vs flat-tier on the call |
| 6 | Tenant isolation | Logical only (org_id column) in Phase 6; Phase 6.5 adds dedicated-DB option | Compliance regime (FedRAMP, SOC2, HIPAA) may force dedicated infra |
| 7 | PII handling | Minimum — name + email + org membership only | Customer may demand GDPR/CCPA workflows (delete-user endpoint, data export) |
| 8 | RBAC matrix | `owner / admin / member` per org | May need finer roles (publisher, reviewer, billing-admin); reuse via custom `permissions JSONB` on `org_members` |

## Why "first paying-customer conversation" is the right gate

- **Too early to build now.** Demand is unproven. Every speculative Phase 6 line of code carries the risk of being wrong for the actual first customer's shape.
- **Too late to wait for a signed contract.** Procurement cycles take months. If we wait for the ink to dry, we'll be in implementation hell during the customer's first 60 days when they wanted to be onboarded.
- **Conversation = right precision.** A real conversation gives us: (a) a person, (b) a timeline, (c) constraints that disambiguate the 8 decisions above. That's exactly the input the Roadmap can't predict.
- **Open-source posture preserved.** We don't ship features for hypothetical customers; we ship them for known ones. Until then, every cycle goes to Phases 4 + 5 + 7 (signatures, remote install, AgentPack integration) — features that benefit every user.

## Gate-flip procedure (when triggered)

1. Spawn a new ALGORITHM run at E5 with this gate doc + Roadmap § Phase 6 as OBSERVE input.
2. Run an Interview workflow (`Skill("ISA", "interview")`) against the customer's actual requirements — fill in the 8 decisions above with their concrete constraints.
3. Scaffold a project ISA for Phase 6: add ~80-120 ISCs across orgs + WorkOS + audit + policy + UI surfaces.
4. Implement in a single sprint with hard gate criteria from `spec/06` (per the existing Roadmap Phase 6 gate).
5. v0.6.0 ships against that one customer's needs first; subsequent customer requests refine.

## Anti-criteria for this gate document

- **Anti:** This document does NOT contain implementation code, schema migrations, or new env vars. It is policy.
- **Anti:** This document does NOT propose pricing tiers, plan names, or feature gates beyond the trigger.
- **Anti:** This document is not a marketing page — it does not promise capabilities to prospects. It is internal sequencing discipline.
- **Anti:** This document does NOT extend or modify Phase 4 or Phase 5 work. Phase 4 (signatures) ships under v0.4.0 with this gate untouched; Phase 5 (remote install) continues under v0.5.0.

## Open-source positioning reminder

Just to make this unambiguous: AgentPack itself stays open source. Phase 6 is "enterprise self-host + hosted enterprise tier of the agentpack.dev registry" — both of which sit **on top of** the open-source core. A customer can:

- Self-host the registry today using the public source (Phase 3+5 already ships local-postgres + local-R2-shim paths).
- Run Phase 4 signing today (when Phase 4 ships under v0.4.0) on their own self-hosted registry.
- Not need Phase 6 at all — orgs are an opt-in convenience for teams who want shared publisher namespaces, central policy, and SSO. A team of three can keep using personal publisher accounts indefinitely.

Phase 6 is **convenience + assurance** for teams who choose to pay for it. The standard is universal.

---

*Last updated: 2026-05-19. Next review: when trigger fires, OR every 90 days as a sanity check on whether the trigger should be adjusted.*
