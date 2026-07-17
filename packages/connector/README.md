# @agentpack/connector (prototype)

A thin **remote MCP connector** that exposes an AgentPack's guidance to **every
Claude surface** — claude.ai web, Desktop, Cowork, and mobile/Dispatch —
including the surfaces a plugin can't reach (pure chat, mobile).

## Why this exists

Of a pack's atoms, only two types travel account-level across all surfaces:
**Skills** and **MCP servers/connectors**. A Claude Code **plugin**
(`agentpack pack plugin`) covers the plugin-aware surfaces (Code, Cowork,
Desktop, the web Directory). This connector covers the rest: a single remote
MCP server reaches _every_ surface at once, including plain claude.ai chat and
mobile.

It reshapes the portable subset of a pack into MCP primitives:

| Pack atom                                             | MCP primitive                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `skill`, `command`, `instruction`, `rule`, `subagent` | **prompt** (invokable) + **resource** (readable)               |
| `hook`                                                | — not carried (no MCP equivalent; Claude Code event-loop only) |
| `mcp_server`                                          | — not re-wrapped (already its own connector)                   |

**Honest limit:** MCP cannot make any of this _ambient_ the way `CLAUDE.md` is
in Claude Code — prompts are invoked, not auto-loaded. Hooks and ambient
instructions remain Claude-Code-only. This connector bridges what is bridgeable.

## Run it (local)

```bash
pnpm --filter @agentpack/connector build
AGENTPACK_CONNECTOR_TOKEN=$(openssl rand -hex 32) \
  node packages/connector/dist/serve.js ./examples/pr-quality
# MCP endpoint at http://localhost:8787/mcp ; health at /healthz
```

Then add it as a **Custom Connector** (remote MCP) in claude.ai or Claude
Desktop settings, pointing at the `/mcp` URL, with the same token as a
`Authorization: Bearer` header.

## Authentication (required, fail-closed)

The server is **auth-by-default**: it refuses to start unless
`AGENTPACK_CONNECTOR_TOKEN` is set and ≥32 characters. There is no skip-auth
branch — local dev uses a real token through the same verifier.

| Env var                             | Required            | Purpose                                                                                                                                              |
| ----------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTPACK_CONNECTOR_TOKEN`         | **yes** (≥32 chars) | Bearer token. `/mcp` requests must send `Authorization: Bearer <token>`; compared in constant time. Missing/invalid → `401` with `WWW-Authenticate`. |
| `AGENTPACK_CONNECTOR_ALLOWED_HOSTS` | no                  | Comma-separated extra Host/Origin allowlist entries (DNS-rebinding guard). Defaults always include `localhost`, `127.0.0.1`, `[::1]`.                |
| `AGENTPACK_CONNECTOR_PORT`          | no                  | Listen port (default `8787`).                                                                                                                        |

`/healthz` is intentionally public (load-balancer probes); every other route
requires the token. A **DNS-rebinding guard** rejects requests whose `Host`
(or, when present, `Origin`) host isn't in the allowlist, so a malicious web
page can't reach a locally-bound connector.

## Before hosting it

The remaining gap is **hosting**: provisioning recurring hosted infra is out of
scope here (cost policy). To deploy later, run `node dist/serve.js` on any Node
host (Fluid Compute / a container) behind TLS, with `AGENTPACK_CONNECTOR_TOKEN`
set and the public hostname added to `AGENTPACK_CONNECTOR_ALLOWED_HOSTS`.

## Status

Prototype with auth. The catalog builder, MCP registration, bearer auth, and
DNS-rebinding guard are covered by tests (33 total, incl. a bound-socket
round-trip); a full MCP **client** handshake against a running server is not
yet wired into CI.
