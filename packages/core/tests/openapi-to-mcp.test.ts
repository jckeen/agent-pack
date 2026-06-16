import { describe, expect, it } from "vitest";
import { openapiToMcp, transpileOpenApiText, toToolName } from "../src/index.js";

const API_KEY_DOC = {
  openapi: "3.1.0",
  info: { title: "Tickets API", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/tickets": {
      get: {
        operationId: "listTickets",
        summary: "List tickets",
        parameters: [
          { name: "status", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: true, schema: { type: "integer" } },
        ],
      },
      post: {
        operationId: "createTicket",
        summary: "Create a ticket",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["subject"],
                properties: { subject: { type: "string" }, body: { type: "string" } },
              },
            },
          },
        },
      },
    },
    "/tickets/{ticketId}": {
      get: {
        operationId: "getTicket",
        parameters: [
          { name: "ticketId", in: "path", required: true, schema: { type: "string" } },
        ],
      },
    },
  },
  components: {
    securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" } },
  },
  security: [{ apiKey: [] }],
};

describe("toToolName", () => {
  it("sanitizes to an MCP-safe identifier", () => {
    expect(toToolName("list Tickets!")).toBe("list_Tickets");
    expect(toToolName("get-ticket")).toBe("get-ticket");
    expect(toToolName("")).toBe("operation");
  });
});

describe("openapiToMcp — operationId → tool", () => {
  it("emits one tool per operationId across all methods/paths", () => {
    const out = openapiToMcp(API_KEY_DOC);
    expect(out.tools.map((t) => t.name).sort()).toEqual([
      "createTicket",
      "getTicket",
      "listTickets",
    ]);
  });

  it("carries method, path, and summary through", () => {
    const out = openapiToMcp(API_KEY_DOC);
    const create = out.tools.find((t) => t.name === "createTicket")!;
    expect(create.method).toBe("POST");
    expect(create.path).toBe("/tickets");
    expect(create.description).toBe("Create a ticket");
    expect(out.title).toBe("Tickets API");
    expect(out.url).toBe("https://api.example.com/v1");
  });

  it("derives a tool name from method+path when operationId is absent", () => {
    const out = openapiToMcp({
      paths: { "/ping": { get: { summary: "Ping" } } },
    });
    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]!.name).toBe("get_ping");
    expect(out.warnings.some((w) => /no operationId/i.test(w))).toBe(true);
  });

  it("de-dupes colliding tool names", () => {
    const out = openapiToMcp({
      paths: {
        "/a": { get: { operationId: "dup" } },
        "/b": { get: { operationId: "dup" } },
      },
    });
    expect(out.tools.map((t) => t.name).sort()).toEqual(["dup", "dup_2"]);
  });
});

describe("openapiToMcp — inputSchema derivation", () => {
  it("folds query/path params into properties with required flags", () => {
    const out = openapiToMcp(API_KEY_DOC);
    const list = out.tools.find((t) => t.name === "listTickets")!;
    expect(Object.keys(list.inputSchema.properties).sort()).toEqual(["limit", "status"]);
    expect(list.inputSchema.required).toEqual(["limit"]);
  });

  it("folds JSON requestBody object properties + required at the top level", () => {
    const out = openapiToMcp(API_KEY_DOC);
    const create = out.tools.find((t) => t.name === "createTicket")!;
    expect(Object.keys(create.inputSchema.properties).sort()).toEqual(["body", "subject"]);
    expect(create.inputSchema.required).toEqual(["subject"]);
  });

  it("includes path params as required", () => {
    const out = openapiToMcp(API_KEY_DOC);
    const get = out.tools.find((t) => t.name === "getTicket")!;
    expect(get.inputSchema.required).toEqual(["ticketId"]);
  });
});

describe("openapiToMcp — auth mapping", () => {
  it("maps apiKey to a required secret env var", () => {
    const out = openapiToMcp(API_KEY_DOC);
    expect(out.auth.scheme).toBe("apiKey");
    expect(out.auth.secrets.map((s) => s.name)).toEqual(["X_API_KEY"]);
    expect(out.auth.scopes).toEqual([]);
  });

  it("maps oauth2 to scopes with no static secret", () => {
    const out = openapiToMcp({
      paths: { "/x": { get: { operationId: "x" } } },
      components: {
        securitySchemes: {
          oauth: {
            type: "oauth2",
            flows: { authorizationCode: { scopes: { "read:x": "", "write:x": "" } } },
          },
        },
      },
      security: [{ oauth: ["read:x"] }],
    });
    expect(out.auth.scheme).toBe("oauth2");
    expect(out.auth.scopes).toEqual(["read:x"]);
    expect(out.auth.secrets).toEqual([]);
  });

  it("collects oauth scopes from flows when the requirement lists none", () => {
    const out = openapiToMcp({
      paths: { "/x": { get: { operationId: "x" } } },
      components: {
        securitySchemes: {
          oauth: {
            type: "oauth2",
            flows: { authorizationCode: { scopes: { "read:x": "", "write:x": "" } } },
          },
        },
      },
      security: [{ oauth: [] }],
    });
    expect(out.auth.scopes.sort()).toEqual(["read:x", "write:x"]);
  });

  it("maps http (bearer) to a token secret", () => {
    const out = openapiToMcp({
      paths: { "/x": { get: { operationId: "x" } } },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
      security: [{ bearer: [] }],
    });
    expect(out.auth.scheme).toBe("http");
    expect(out.auth.secrets.map((s) => s.name)).toEqual(["API_TOKEN"]);
  });

  it("maps no declared security to none", () => {
    const out = openapiToMcp({ paths: { "/x": { get: { operationId: "x" } } } });
    expect(out.auth.scheme).toBe("none");
    expect(out.auth.secrets).toEqual([]);
  });
});

describe("transpileOpenApiText", () => {
  it("parses YAML text and transpiles", () => {
    const out = transpileOpenApiText(
      "openapi: 3.1.0\npaths:\n  /x:\n    get:\n      operationId: getX\n",
    );
    expect(out.tools.map((t) => t.name)).toEqual(["getX"]);
  });

  it("warns instead of throwing on unparseable input", () => {
    const out = transpileOpenApiText(": : : not yaml [");
    expect(out.tools).toEqual([]);
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it("warns when no servers url is present", () => {
    const out = transpileOpenApiText("paths:\n  /x:\n    get:\n      operationId: getX\n");
    expect(out.url).toBeNull();
    expect(out.warnings.some((w) => /servers/i.test(w))).toBe(true);
  });
});
