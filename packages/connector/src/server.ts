import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { ConnectorCatalog } from "./catalog.js";

/**
 * Build an MCP server that serves a pack catalog: each carried atom becomes a
 * prompt (the guidance text, returned as a user message) and a resource (the
 * raw content). A `pack_info` tool returns the catalog summary so a client can
 * discover what's available.
 *
 * Uses the current SDK registration API (`registerPrompt`/`registerResource`/
 * `registerTool`, verified against @modelcontextprotocol/sdk@1.29.0).
 */
export function buildMcpServer(catalog: ConnectorCatalog): McpServer {
  const server = new McpServer({
    name: `agentpack-${catalog.packSlug}`,
    version: catalog.packVersion,
  });

  for (const p of catalog.prompts) {
    server.registerPrompt(p.name, { title: p.title, description: p.description }, () => ({
      messages: [{ role: "user", content: { type: "text", text: p.body } }],
    }));
  }

  for (const r of catalog.resources) {
    server.registerResource(
      r.name,
      r.uri,
      { title: r.name, description: r.name, mimeType: r.mimeType },
      (uri) => ({
        contents: [{ uri: uri.href, mimeType: r.mimeType, text: r.body }],
      }),
    );
  }

  server.registerTool(
    "pack_info",
    {
      title: "Pack info",
      description:
        "Summarize this AgentPack connector: pack identity, the prompts/resources it serves, and the atom types it cannot carry (hooks, MCP servers).",
    },
    () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              packId: catalog.packId,
              packName: catalog.packName,
              packVersion: catalog.packVersion,
              prompts: catalog.prompts.map((p) => ({
                name: p.name,
                atomType: p.atomType,
              })),
              resources: catalog.resources.map((r) => r.uri),
              excluded: catalog.excluded,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}

/**
 * A Hono app exposing the catalog over Streamable HTTP at `/mcp`, plus a
 * `/healthz` probe. Stateless (a fresh server + transport per request) — the
 * simplest correct model for a connector prototype.
 *
 * NOTE: this prototype binds with no auth. Before exposing it publicly, add a
 * bearer-token middleware (MCP resource-server pattern) and enable the
 * transport's DNS-rebinding protection. See README.
 */
export function createApp(catalog: ConnectorCatalog): Hono {
  const app = new Hono();

  app.get("/healthz", (c) =>
    c.json({ ok: true, pack: catalog.packId, version: catalog.packVersion }),
  );

  app.all("/mcp", async (c) => {
    const server = buildMcpServer(catalog);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
