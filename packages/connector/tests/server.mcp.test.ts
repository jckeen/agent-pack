import { describe, it, expect } from "vitest";
import * as path from "node:path";

import { loadPackCatalog } from "../src/catalog.js";
import { createApp } from "../src/server.js";

// These tests drive the wired-up Hono app (createApp) end-to-end over the
// MCP Streamable-HTTP transport in stateless mode. They close the auth
// boundary loop: a request carrying the correct bearer token passes auth +
// DNS-rebinding middleware AND is served real pack content by the handler at
// server.ts:109-116. In doing so they exercise the prompt/resource/tool
// registration callbacks in buildMcpServer (server.ts:25, 35-36, 48-68) that
// only run when an MCP client actually reads a prompt/resource or calls a tool
// — the `initialize`-only happy-path test in auth.test.ts never reaches them.

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");
const VALID_TOKEN = "test-token-minimum-16chars";

function mcpRequest(body: unknown, token: string = VALID_TOKEN): Request {
  return new Request("http://ignored/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      host: "localhost",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// The transport returns an SSE stream (text/event-stream); parse out the
// single JSON-RPC payload carried on the `data:` line.
async function readJsonRpc(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`no SSE data line in response body: ${text.slice(0, 200)}`);
  }
  return JSON.parse(dataLine.slice("data:".length).trim()) as Record<string, unknown>;
}

describe("createApp MCP content delivery (auth boundary → handler)", () => {
  it("an authenticated tools/call reaches the pack_info tool callback (server.ts:48-68)", async () => {
    const catalog = await loadPackCatalog(EXAMPLE);
    const app = createApp(catalog, VALID_TOKEN);

    const res = await app.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "pack_info", arguments: {} },
      }),
    );
    expect(res.status).toBe(200);

    const rpc = await readJsonRpc(res);
    const result = rpc["result"] as { content?: Array<{ text?: string }> };
    const text = result?.content?.[0]?.text ?? "";
    const info = JSON.parse(text) as Record<string, unknown>;

    // The callback serializes the catalog summary — prove the live identity
    // and the terminal-only exclusions made it through the wired handler.
    expect(info["packId"]).toBe(catalog.packId);
    expect(info["packName"]).toBe(catalog.packName);
    expect(info["packVersion"]).toBe(catalog.packVersion);
    expect(Array.isArray(info["excluded"])).toBe(true);
  });

  it("an authenticated prompts/get returns the atom's guidance text (server.ts:25)", async () => {
    const catalog = await loadPackCatalog(EXAMPLE);
    const app = createApp(catalog, VALID_TOKEN);
    const prompt = catalog.prompts[0];
    expect(prompt).toBeDefined();

    const res = await app.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "prompts/get",
        params: { name: prompt!.name, arguments: {} },
      }),
    );
    expect(res.status).toBe(200);

    const rpc = await readJsonRpc(res);
    const result = rpc["result"] as {
      messages?: Array<{ role: string; content: { type: string; text: string } }>;
    };
    const message = result?.messages?.[0];
    expect(message?.role).toBe("user");
    expect(message?.content.type).toBe("text");
    // The prompt callback returns the atom body verbatim.
    expect(message?.content.text).toBe(prompt!.body);
  });

  it("an authenticated resources/read returns the atom's raw content (server.ts:35-36)", async () => {
    const catalog = await loadPackCatalog(EXAMPLE);
    const app = createApp(catalog, VALID_TOKEN);
    const resource = catalog.resources[0];
    expect(resource).toBeDefined();

    const res = await app.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: resource!.uri },
      }),
    );
    expect(res.status).toBe(200);

    const rpc = await readJsonRpc(res);
    const result = rpc["result"] as {
      contents?: Array<{ uri: string; mimeType: string; text: string }>;
    };
    const content = result?.contents?.[0];
    expect(content?.uri).toBe(resource!.uri);
    expect(content?.mimeType).toBe(resource!.mimeType);
    expect(content?.text).toBe(resource!.body);
  });

  it("a tools/call with NO bearer token is rejected before the handler runs (401)", async () => {
    // Confirms the content-delivery path above is genuinely gated: the same
    // request without Authorization never reaches the pack_info callback.
    const catalog = await loadPackCatalog(EXAMPLE);
    const app = createApp(catalog, VALID_TOKEN);

    const res = await app.fetch(
      new Request("http://ignored/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "pack_info", arguments: {} },
        }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("a tools/call with a disallowed Host is rejected by the rebinding guard (403)", async () => {
    // DNS-rebinding protection runs ahead of bearer auth; a forbidden Host is
    // refused even when the correct token is supplied.
    const catalog = await loadPackCatalog(EXAMPLE);
    const app = createApp(catalog, VALID_TOKEN);

    const res = await app.fetch(
      new Request("http://ignored/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "evil.attacker.com",
          authorization: `Bearer ${VALID_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "pack_info", arguments: {} },
        }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
