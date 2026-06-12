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
node packages/connector/dist/serve.js ./examples/pr-quality
# MCP endpoint at http://localhost:8787/mcp ; health at /healthz
```

Then add it as a **Custom Connector** (remote MCP) in claude.ai or Claude
Desktop settings, pointing at the `/mcp` URL.

## Before exposing publicly

This prototype binds with **no authentication** and is intended for local use.
Productionizing requires:

1. **Bearer auth** — the MCP resource-server pattern: a middleware that
   validates `Authorization: Bearer` against your IdP (the SDK ships
   `requireBearerAuth` + `mcpAuthMetadataRouter`), plus
   `/.well-known/oauth-protected-resource` metadata.
2. **DNS-rebinding protection** — set `enableDnsRebindingProtection: true` and
   `allowedHosts` on the transport once it binds to a public interface.
3. **Hosting** — any Node host (Fluid Compute / a container). **Deferred:**
   provisioning recurring hosted infra is out of scope for this prototype. To
   deploy later: `vercel deploy` (or a container) running `node dist/serve.js`,
   with the pack baked in or fetched at boot.

## Status

Prototype. The catalog builder and MCP registration are covered by tests; a
full MCP client handshake against a running server has not been wired into CI.
