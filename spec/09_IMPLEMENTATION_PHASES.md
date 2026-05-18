# Implementation Phases

## Phase 1: Local MVP

Build:

- Monorepo
- Core schema
- Manifest parser
- Validator
- Risk engine
- Permission summary
- Planner
- Adapter exporters
- CLI validate/inspect/plan/export
- Registry static web app
- Seed packs
- Example PR pack
- Tests

## Phase 2: Local install/uninstall

Add:

- file diff preview
- actual install into project root
- backups
- uninstall manifests
- rollback
- lockfiles
- install history

## Phase 3: Registry backend

Add:

- database
- users
- publishers
- pack publishing
- immutable versions
- uploaded artifacts
- registry API
- search
- reviews
- downloads

## Phase 4: Security and trust

Add:

- checksums
- signatures
- provenance
- verified publishers
- automated security scans
- malicious package reporting
- blocked package/version status

## Phase 5: Remote CLI installs

Add:

- `workgraph install publisher/pack`
- version pinning
- registry auth
- private packs
- enterprise policy file
- offline cache

## Phase 6: Enterprise

Add:

- private registries
- org workspaces
- SSO
- audit logs
- allowlists/blocklists
- admin-approved install profiles
- policy-as-code

## Phase 7: Workgraph integration

Add:

- export real user/team workflows as AgentPacks
- private team libraries
- trust graph
- Agent Commons publishing
- contextual recommendations
