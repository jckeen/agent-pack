# @agentpack/connector (prototype)

A remote MCP server prototype that exposes AgentPack guidance as prompts and
resources. It is intended for clients that support those MCP primitives and this
server's authentication method; it is not a verified integration with every
ChatGPT or Claude surface.

## Why this exists

A pack can be presented through MCP as an alternative to generated configuration
files or skill packages. This server makes selected kinds of guidance readable
and invokable by a compatible client. It does not execute the pack's workflows,
install account configuration, or grant a client new runtime capabilities.

It reshapes the portable subset of a pack into MCP primitives:

| Pack atom                                             | MCP primitive                                                |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `skill`, `command`, `instruction`, `rule`, `subagent` | **prompt** (invokable) + **resource** (readable)             |
| `hook`                                                | — not carried (this server does not execute lifecycle hooks) |
| `mcp_server`                                          | — not re-wrapped (already its own connector)                 |

**Limit:** prompts/resources are not repository or Project instructions. The host
decides whether to expose them and when to load them. A successful server response
does not establish account-side installation or equivalent behavior across clients.

## Run it (local)

```bash
pnpm --filter @agentpack/connector build
AGENTPACK_CONNECTOR_TOKEN=$(openssl rand -hex 32) \
  node packages/connector/dist/serve.js ./examples/pr-quality
# MCP endpoint at http://localhost:8787/mcp ; health at /healthz
```

Use an MCP client that can send the required `Authorization: Bearer` header to
test the local endpoint. Do not assume a consumer connector UI accepts arbitrary
headers. Cloud-hosted clients cannot reach a server bound only to your machine:
Claude's [remote connector documentation](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
requires an endpoint reachable from its infrastructure. Hosting and native client
authentication compatibility must be verified before recommending this route to users.

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

Hosting is only one requirement. A deployment needs TLS, appropriate secrets and
hostname configuration, and a client-compatible authentication flow. This prototype
implements bearer authentication, not an OAuth authorization server. Validate the
intended client's tools, prompts, and resources support before deploying it.

## Status

Prototype with authentication and tests for the catalog, MCP registration, bearer
authentication, and Host/Origin checks. See [tests](./tests) for the exercised
behavior. Passing those tests does not establish native ChatGPT or Claude account
compatibility. The catalog currently loads the manifest's atoms without install
profile selection; review what it exposes before sharing a server.
