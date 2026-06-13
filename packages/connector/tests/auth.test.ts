import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import * as path from "node:path";

import {
  timingSafeEqual_str,
  validateTokenEnv,
  buildAllowedHosts,
  DEFAULT_ALLOWED_HOSTS,
  TOKEN_ENV_VAR,
  TOKEN_MIN_LENGTH,
} from "../src/auth.js";
import { loadPackCatalog } from "../src/catalog.js";
import { createApp } from "../src/server.js";

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");
const VALID_TOKEN = "test-token-minimum-16chars";

// ── timingSafeEqual_str ──────────────────────────────────────────────────────

describe("timingSafeEqual_str", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual_str("hello", "hello")).toBe(true);
    expect(timingSafeEqual_str(VALID_TOKEN, VALID_TOKEN)).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(timingSafeEqual_str("aaaa", "aaab")).toBe(false);
  });

  it("returns false for different strings of different length", () => {
    expect(timingSafeEqual_str("short", "longer-value")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(timingSafeEqual_str("", "")).toBe(false);
    expect(timingSafeEqual_str("", "abc")).toBe(false);
    expect(timingSafeEqual_str("abc", "")).toBe(false);
  });
});

// ── validateTokenEnv ─────────────────────────────────────────────────────────

describe("validateTokenEnv", () => {
  const originalEnv = process.env[TOKEN_ENV_VAR];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[TOKEN_ENV_VAR];
    } else {
      process.env[TOKEN_ENV_VAR] = originalEnv;
    }
  });

  it("throws when token env var is unset", () => {
    delete process.env[TOKEN_ENV_VAR];
    expect(() => validateTokenEnv()).toThrow(TOKEN_ENV_VAR);
  });

  it("throws when token is shorter than TOKEN_MIN_LENGTH", () => {
    process.env[TOKEN_ENV_VAR] = "tooshort";
    expect(() => validateTokenEnv()).toThrow(/too short/);
  });

  it("throws when token is exactly TOKEN_MIN_LENGTH - 1 chars", () => {
    process.env[TOKEN_ENV_VAR] = "a".repeat(TOKEN_MIN_LENGTH - 1);
    expect(() => validateTokenEnv()).toThrow(/too short/);
  });

  it("returns the token when it meets the minimum length", () => {
    process.env[TOKEN_ENV_VAR] = VALID_TOKEN;
    expect(validateTokenEnv()).toBe(VALID_TOKEN);
  });

  it("accepts tokens exactly at TOKEN_MIN_LENGTH", () => {
    process.env[TOKEN_ENV_VAR] = "a".repeat(TOKEN_MIN_LENGTH);
    expect(validateTokenEnv()).toBe("a".repeat(TOKEN_MIN_LENGTH));
  });
});

// ── buildAllowedHosts ────────────────────────────────────────────────────────

describe("buildAllowedHosts", () => {
  const originalEnv = process.env["AGENTPACK_CONNECTOR_ALLOWED_HOSTS"];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["AGENTPACK_CONNECTOR_ALLOWED_HOSTS"];
    } else {
      process.env["AGENTPACK_CONNECTOR_ALLOWED_HOSTS"] = originalEnv;
    }
  });

  it("always includes the default loopback hosts", () => {
    delete process.env["AGENTPACK_CONNECTOR_ALLOWED_HOSTS"];
    const hosts = buildAllowedHosts();
    for (const h of DEFAULT_ALLOWED_HOSTS) {
      expect(hosts.has(h)).toBe(true);
    }
  });

  it("adds extra hosts from AGENTPACK_CONNECTOR_ALLOWED_HOSTS", () => {
    process.env["AGENTPACK_CONNECTOR_ALLOWED_HOSTS"] = "example.com, my-server.internal";
    const hosts = buildAllowedHosts();
    expect(hosts.has("example.com")).toBe(true);
    expect(hosts.has("my-server.internal")).toBe(true);
  });
});

// ── DNS-rebinding middleware (handler-level, synthetic Requests) ──────────────
//
// Node's fetch() enforces the WHATWG Fetch spec and silently ignores any
// attempt to override the Host header. We therefore drive the Hono app's
// fetch() directly with synthetic Request objects — full header control,
// no real socket needed, and no spec-enforcement stripping our headers.

describe("dnsRebindingMiddleware (handler-level)", () => {
  async function callApp(
    hostHeader: string,
    originHeader?: string,
    allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]),
  ): Promise<Response> {
    const catalog = await loadPackCatalog(EXAMPLE);
    const app = createApp(catalog, VALID_TOKEN, allowedHosts);
    const headers: Record<string, string> = { host: hostHeader };
    if (originHeader) headers["origin"] = originHeader;
    return app.fetch(new Request("http://ignored/healthz", { headers }));
  }

  it("rejects requests with a disallowed Host header (403)", async () => {
    const res = await callApp("evil.attacker.com");
    expect(res.status).toBe(403);
  });

  it("allows requests with Host: 127.0.0.1", async () => {
    const res = await callApp("127.0.0.1");
    expect(res.status).toBe(200);
  });

  it("allows requests with Host: localhost", async () => {
    const res = await callApp("localhost");
    expect(res.status).toBe(200);
  });

  it("allows Host with port suffix when base hostname is allowed (localhost:8787)", async () => {
    const res = await callApp("localhost:8787");
    expect(res.status).toBe(200);
  });

  it("allows Host with port suffix when base hostname is allowed (127.0.0.1:8787)", async () => {
    const res = await callApp("127.0.0.1:8787");
    expect(res.status).toBe(200);
  });

  it("rejects when Origin header host is disallowed", async () => {
    const res = await callApp("127.0.0.1", "http://evil.attacker.com");
    expect(res.status).toBe(403);
  });

  it("allows when Origin header host matches an allowed host", async () => {
    const res = await callApp("localhost", "http://localhost");
    expect(res.status).toBe(200);
  });

  it("rejects a malformed Origin header", async () => {
    const res = await callApp("localhost", "not-a-valid-url");
    expect(res.status).toBe(403);
  });

  it("permits a custom configured host when in allowlist", async () => {
    const custom = new Set(["localhost", "127.0.0.1", "[::1]", "my-server.example.com"]);
    const res = await callApp("my-server.example.com", undefined, custom);
    expect(res.status).toBe(200);
  });

  it("rejects a custom host that is not in the allowlist", async () => {
    const custom = new Set(["localhost", "127.0.0.1", "[::1]", "my-server.example.com"]);
    const res = await callApp("other.example.com", undefined, custom);
    expect(res.status).toBe(403);
  });
});

// ── Bearer auth middleware (handler-level, synthetic Requests) ────────────────

describe("bearerAuthMiddleware (handler-level)", () => {
  async function callMcp(authHeader?: string): Promise<Response> {
    const catalog = await loadPackCatalog(EXAMPLE);
    const app = createApp(catalog, VALID_TOKEN);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      host: "localhost",
    };
    if (authHeader !== undefined) headers["authorization"] = authHeader;
    return app.fetch(
      new Request("http://ignored/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.1" },
          },
        }),
      }),
    );
  }

  it("returns 401 with WWW-Authenticate when Authorization is absent", async () => {
    const res = await callMcp();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("returns 401 with a wrong bearer token", async () => {
    const res = await callMcp("Bearer wrong-token-that-is-long-enough");
    expect(res.status).toBe(401);
  });

  it("returns 401 for a Bearer prefix with an empty token", async () => {
    const res = await callMcp("Bearer ");
    expect(res.status).toBe(401);
  });

  it("returns 401 for a non-Bearer scheme", async () => {
    const res = await callMcp("Basic dXNlcjpwYXNz");
    expect(res.status).toBe(401);
  });

  it("passes through to MCP handling with the correct bearer token (200)", async () => {
    const res = await callMcp(`Bearer ${VALID_TOKEN}`);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
  });
});

// ── Integration: real socket — auth but not Host (fetch strips Host) ──────────
//
// These tests bind a real TCP socket to validate that the server starts up,
// the middleware chain wires together, and healthz is public. Host-override
// tests are handled above via handler-level calls since Node fetch ignores
// the host header.

async function startServer(
  token: string,
  allowedHosts?: Set<string>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const catalog = await loadPackCatalog(EXAMPLE);
  const hosts = allowedHosts ?? new Set(["localhost", "127.0.0.1", "[::1]"]);
  const app = createApp(catalog, token, hosts);

  return new Promise((resolve, reject) => {
    let server: ServerType;
    try {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        const baseUrl = `http://127.0.0.1:${info.port}`;
        resolve({
          baseUrl,
          close: () =>
            new Promise<void>((res, rej) =>
              server.close((err) => (err ? rej(err) : res())),
            ),
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

describe("bearer auth middleware (socket integration)", () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ baseUrl, close } = await startServer(VALID_TOKEN));
  });

  afterEach(async () => {
    await close();
  });

  it("returns 401 when Authorization header is absent", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("returns 401 with a wrong bearer token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token-that-is-long-enough",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(res.status).toBe(401);
  });

  it("/healthz is public (no token required)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
  });
});
