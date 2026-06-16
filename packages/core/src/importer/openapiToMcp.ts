// OpenAPI-Action → MCP transpiler. Pure, no I/O.
//
// This is the reusable interop primitive of the ChatGPT-GPT importer: an
// OpenAPI document (a GPT Action schema, but equally an Apps SDK or Codex tool
// schema) is turned into a set of MCP tools — one per `operationId` — plus the
// auth shape an MCP connector needs. MCP is the shared spine across OpenAI Apps
// SDK, Codex, and Claude Connectors, so this single transpile covers all three.
//
// IMPORTANT (honesty): the OUTPUT IS SCAFFOLDING. We derive tool names, input
// schemas, and the auth scheme/scopes a connector must request — but we do NOT
// produce a running MCP server. The emitted `mcp_server` atom is a connector
// recipe + tool catalogue; a human must stand up the actual remote MCP endpoint
// that fronts the API (or use a generic OpenAPI→MCP proxy) and review auth
// scopes before wiring it to claude.ai.

import { parse as parseYaml } from "yaml";

/** A JSON-Schema-ish input schema for an MCP tool (subset we emit). */
export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface McpTool {
  /** Derived from `operationId` (or method+path when absent). */
  name: string;
  /** HTTP method, uppercased. */
  method: string;
  /** Path template, e.g. `/tickets/{ticketId}`. */
  path: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

export type McpAuthScheme = "none" | "apiKey" | "oauth2" | "http";

export interface McpAuth {
  /** Normalized scheme. `none` when the doc declares no security. */
  scheme: McpAuthScheme;
  /** OAuth scopes (empty for non-oauth schemes). */
  scopes: string[];
  /** Secret env var names a connector must supply (empty for `none`/oauth-only-via-flow). */
  secrets: Array<{ name: string; description?: string }>;
}

export interface TranspiledMcp {
  /** Server display name (from `info.title`). */
  title: string;
  /** First declared server URL, or null when the doc omits `servers`. */
  url: string | null;
  tools: McpTool[];
  auth: McpAuth;
  /** Non-fatal problems (missing operationId, unparseable schema, …). */
  warnings: string[];
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

/** Turn an operationId / fallback into an MCP-tool-safe name. */
export function toToolName(raw: string): string {
  const name = raw
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return name || "operation";
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Map an OpenAPI `components.securitySchemes` + top-level `security` into a
 * single normalized auth descriptor. We pick the first scheme referenced by the
 * top-level `security` requirement (the common GPT-Action case), falling back
 * to the first declared scheme, then to `none`.
 */
function deriveAuth(doc: Record<string, unknown>, warnings: string[]): McpAuth {
  const components = asObject(doc["components"]);
  const schemes = asObject(components?.["securitySchemes"]) ?? {};
  const security = Array.isArray(doc["security"]) ? doc["security"] : [];

  // Resolve which named scheme is actually required, + any oauth scopes.
  let chosenName: string | undefined;
  let scopes: string[] = [];
  for (const req of security) {
    const reqObj = asObject(req);
    if (!reqObj) continue;
    const [name, rawScopes] = Object.entries(reqObj)[0] ?? [];
    if (!name) continue;
    chosenName = name;
    scopes = Array.isArray(rawScopes)
      ? rawScopes.filter((s): s is string => typeof s === "string")
      : [];
    break;
  }
  if (!chosenName) chosenName = Object.keys(schemes)[0];

  if (!chosenName) {
    return { scheme: "none", scopes: [], secrets: [] };
  }
  const scheme = asObject(schemes[chosenName]);
  const type = asString(scheme?.["type"]);

  if (type === "apiKey") {
    const headerName = asString(scheme?.["name"]) ?? chosenName;
    const envVar = envVarName(headerName);
    return {
      scheme: "apiKey",
      scopes: [],
      secrets: [
        {
          name: envVar,
          description: `API key for the \`${headerName}\` header (from OpenAPI apiKey scheme).`,
        },
      ],
    };
  }
  if (type === "oauth2") {
    // Collect scopes both from the requirement and the flows declaration.
    if (scopes.length === 0) {
      const flows = asObject(scheme?.["flows"]);
      for (const flow of Object.values(flows ?? {})) {
        const flowScopes = asObject(asObject(flow)?.["scopes"]);
        if (flowScopes) scopes = [...scopes, ...Object.keys(flowScopes)];
      }
      scopes = [...new Set(scopes)];
    }
    // OAuth is acquired via an authorization flow at connector-add time, so
    // there is no static secret env var — the connector handles the token.
    return { scheme: "oauth2", scopes, secrets: [] };
  }
  if (type === "http") {
    const bearerFormat = asString(scheme?.["scheme"]) ?? "bearer";
    return {
      scheme: "http",
      scopes: [],
      secrets: [
        {
          name: "API_TOKEN",
          description: `HTTP \`${bearerFormat}\` token (from OpenAPI http security scheme).`,
        },
      ],
    };
  }

  warnings.push(
    `Security scheme \`${chosenName}\` has unsupported type \`${type ?? "unknown"}\`; treated as no-auth — review manually.`,
  );
  return { scheme: "none", scopes: [], secrets: [] };
}

/** Header/param name → an UPPER_SNAKE env var. */
function envVarName(raw: string): string {
  const v = raw
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return v || "API_KEY";
}

/** Build a tool inputSchema from parameters + requestBody. */
function deriveInputSchema(
  op: Record<string, unknown>,
  pathLevelParams: unknown[],
  warnings: string[],
  opName: string,
): McpToolInputSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const params = [
    ...pathLevelParams,
    ...(Array.isArray(op["parameters"]) ? op["parameters"] : []),
  ];
  for (const raw of params) {
    const p = asObject(raw);
    if (!p) continue;
    const name = asString(p["name"]);
    if (!name) continue;
    const schema = asObject(p["schema"]) ?? { type: "string" };
    const description = asString(p["description"]);
    properties[name] = description ? { ...schema, description } : { ...schema };
    if (p["required"] === true) required.push(name);
  }

  // requestBody → fold the (JSON) body schema's properties in at the top level.
  const body = asObject(op["requestBody"]);
  if (body) {
    const content = asObject(body["content"]);
    const json =
      asObject(content?.["application/json"]) ??
      (content ? asObject(Object.values(content)[0]) : null);
    const bodySchema = asObject(json?.["schema"]);
    if (bodySchema && asString(bodySchema["type"]) === "object") {
      const props = asObject(bodySchema["properties"]) ?? {};
      for (const [k, v] of Object.entries(props)) properties[k] = v;
      const bodyRequired = bodySchema["required"];
      if (Array.isArray(bodyRequired)) {
        for (const r of bodyRequired) if (typeof r === "string") required.push(r);
      }
    } else if (bodySchema) {
      // Non-object body (array/string/etc.) — expose under a `body` field.
      properties["body"] = bodySchema;
      if (body["required"] === true) required.push("body");
    } else {
      warnings.push(
        `Operation \`${opName}\` has a requestBody with no JSON schema; body params omitted.`,
      );
    }
  }

  const out: McpToolInputSchema = { type: "object", properties };
  if (required.length > 0) out.required = [...new Set(required)];
  return out;
}

/**
 * Transpile a parsed OpenAPI document object into MCP tools + auth.
 * Accepts the already-parsed object (use `transpileOpenApiText` for raw text).
 */
export function openapiToMcp(doc: unknown): TranspiledMcp {
  const warnings: string[] = [];
  const root = asObject(doc);
  if (!root) {
    return {
      title: "API",
      url: null,
      tools: [],
      auth: { scheme: "none", scopes: [], secrets: [] },
      warnings: ["OpenAPI document is not an object; nothing transpiled."],
    };
  }

  const info = asObject(root["info"]);
  const title = asString(info?.["title"]) ?? "API";

  const servers = Array.isArray(root["servers"]) ? root["servers"] : [];
  const url = asString(asObject(servers[0])?.["url"]) ?? null;
  if (!url) {
    warnings.push(
      "OpenAPI document declares no `servers[].url`; the connector URL must be filled in by hand.",
    );
  }

  const auth = deriveAuth(root, warnings);

  const paths = asObject(root["paths"]) ?? {};
  const tools: McpTool[] = [];
  const usedNames = new Set<string>();
  for (const [pathKey, pathItemRaw] of Object.entries(paths)) {
    const pathItem = asObject(pathItemRaw);
    if (!pathItem) continue;
    const pathLevelParams = Array.isArray(pathItem["parameters"])
      ? pathItem["parameters"]
      : [];
    for (const method of HTTP_METHODS) {
      const op = asObject(pathItem[method]);
      if (!op) continue;
      let name = asString(op["operationId"]);
      if (!name) {
        name = toToolName(`${method}_${pathKey}`);
        warnings.push(
          `Operation ${method.toUpperCase()} ${pathKey} has no operationId; derived tool name \`${name}\`.`,
        );
      } else {
        name = toToolName(name);
      }
      // De-dupe tool names (operationIds should be unique, but Actions aren't always).
      let finalName = name;
      let i = 2;
      while (usedNames.has(finalName)) finalName = `${name}_${i++}`;
      usedNames.add(finalName);

      const description =
        asString(op["summary"]) ??
        asString(op["description"]) ??
        `${method.toUpperCase()} ${pathKey}`;

      tools.push({
        name: finalName,
        method: method.toUpperCase(),
        path: pathKey,
        description,
        inputSchema: deriveInputSchema(op, pathLevelParams, warnings, finalName),
      });
    }
  }

  if (tools.length === 0) {
    warnings.push("OpenAPI document declares no operations; no MCP tools produced.");
  }

  return { title, url, tools, auth, warnings };
}

/** Parse raw YAML/JSON OpenAPI text, then transpile. Never throws on bad input. */
export function transpileOpenApiText(text: string): TranspiledMcp {
  let doc: unknown;
  try {
    // `yaml` parses JSON too, so one parser covers both .yaml and .json.
    doc = parseYaml(text);
  } catch (err) {
    return {
      title: "API",
      url: null,
      tools: [],
      auth: { scheme: "none", scopes: [], secrets: [] },
      warnings: [
        `Failed to parse OpenAPI document (${(err as Error).message}); nothing transpiled.`,
      ],
    };
  }
  return openapiToMcp(doc);
}
