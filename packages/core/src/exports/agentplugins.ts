/**
 * Agent Plugins spec support (https://agent-plugins.org).
 *
 * Agent Plugins 1.0.0 (agentplugins/agent-plugins-spec, audited 2026-08-14) is
 * the cross-vendor package format co-authored by AWS, Cursor, Microsoft,
 * OpenAI, Vercel, and Google: a directory with a closed-schema `plugin.json`,
 * optional `skills/` (Agent Skills spec — see ../skills/agentskills.ts), and
 * optional `mcp.json`. Client-specific components live under reverse-domain
 * extension namespaces. Distribution, install, permissions, and security are
 * explicitly out of the spec's scope — AgentPack supplies that layer, exactly
 * as it does above the Agent Skills spec.
 *
 * This module is the single source of truth for the spec rules inside
 * AgentPack. The validators are TypeScript ports of the official JSON Schemas
 * vendored at `schemas/agent-plugins/{plugin,mcp}.schema.json`; the
 * conformance test asserts the ported name grammar matches the vendored
 * pattern byte-for-byte.
 */

export const AGENT_PLUGINS_SPEC_VERSION = "1.0.0";

export const AGENT_PLUGIN_MANIFEST_SCHEMA_ID =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

export const AGENT_PLUGIN_MCP_SCHEMA_ID =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/**
 * AgentPack's reverse-domain extension namespace. `agentpack.dev` is the
 * project's canonical schema host (see schemas/AGENTPACK.schema.json `$id`),
 * so the reverse-DNS form is `dev.agentpack`. Used both as the `extensions`
 * key in plugin.json and as the extension directory name for non-portable
 * components (commands, subagents, hooks).
 */
export const AGENTPACK_EXTENSION_NAMESPACE = "dev.agentpack";

export const AGENT_PLUGIN_NAME_MAX_LENGTH = 64;

/** Ported from the vendored plugin.schema.json `properties.name.pattern`. */
const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const MANIFEST_KNOWN_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

const AUTHOR_KNOWN_FIELDS = new Set(["name", "email", "url"]);

export interface AgentPluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface AgentPluginManifest {
  $schema: typeof AGENT_PLUGIN_MANIFEST_SCHEMA_ID;
  name: string;
  version?: string;
  description?: string;
  author?: AgentPluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, Record<string, unknown>>;
}

export interface AgentPluginStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface AgentPluginRemoteServer {
  type: "streamable-http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type AgentPluginMcpServer = AgentPluginStdioServer | AgentPluginRemoteServer;

export interface AgentPluginMcpConfig {
  $schema: typeof AGENT_PLUGIN_MCP_SCHEMA_ID;
  mcpServers: Record<string, AgentPluginMcpServer>;
}

export interface SpecValidationResult {
  /** Violations of the spec — a conformant client may reject the document. */
  errors: string[];
  /** Report-and-ignore findings (unknown fields, ignorable extensions). */
  warnings: string[];
}

/** Validate a plugin name against the spec grammar. Empty result = valid. */
export function validateAgentPluginName(name: unknown): string[] {
  if (typeof name !== "string" || name.length === 0) {
    return ["Plugin `name` must be a non-empty string"];
  }
  const errors: string[] = [];
  if (name.length > AGENT_PLUGIN_NAME_MAX_LENGTH) {
    errors.push(
      `Plugin name \`${name}\` exceeds ${AGENT_PLUGIN_NAME_MAX_LENGTH} characters (${name.length})`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    errors.push(
      `Plugin name \`${name}\` must be lowercase letters/digits/hyphens/periods, start and end alphanumeric, with no consecutive hyphens or periods`,
    );
  }
  return errors;
}

/**
 * Map an arbitrary slug onto the spec's name grammar: lowercase, non-conformant
 * runs collapsed to single hyphens, edges trimmed, clamped to 64 chars.
 */
export function normalizeAgentPluginName(raw: string): string {
  const normalized = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/[.-]{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, AGENT_PLUGIN_NAME_MAX_LENGTH)
    .replace(/[.-]+$/g, "");
  return normalized || "plugin";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed plugin.json against the spec. Unknown top-level fields are
 * warnings, not errors — the spec requires clients to report and ignore them
 * without invalidating the manifest. A non-object `extensions` is likewise
 * non-fatal (ignored with a warning).
 */
export function validateAgentPluginManifest(json: unknown): SpecValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(json)) {
    return { errors: ["plugin.json must be a JSON object"], warnings };
  }

  if (json["$schema"] !== AGENT_PLUGIN_MANIFEST_SCHEMA_ID) {
    errors.push(
      `plugin.json \`$schema\` must be \`${AGENT_PLUGIN_MANIFEST_SCHEMA_ID}\` (got ${JSON.stringify(json["$schema"] ?? null)})`,
    );
  }
  errors.push(...validateAgentPluginName(json["name"]));

  for (const field of ["version", "description", "homepage", "repository", "license"]) {
    if (field in json && typeof json[field] !== "string") {
      errors.push(`plugin.json \`${field}\` must be a string`);
    }
  }

  if ("author" in json) {
    const author = json["author"];
    if (!isRecord(author)) {
      errors.push("plugin.json `author` must be an object");
    } else {
      for (const [key, value] of Object.entries(author)) {
        if (!AUTHOR_KNOWN_FIELDS.has(key)) {
          errors.push(`plugin.json \`author.${key}\` is not a spec field`);
        } else if (typeof value !== "string") {
          errors.push(`plugin.json \`author.${key}\` must be a string`);
        }
      }
    }
  }

  if ("keywords" in json) {
    const keywords = json["keywords"];
    if (!Array.isArray(keywords) || keywords.some((k) => typeof k !== "string")) {
      errors.push("plugin.json `keywords` must be an array of strings");
    }
  }

  if ("extensions" in json) {
    const extensions = json["extensions"];
    if (!isRecord(extensions)) {
      warnings.push(
        "plugin.json `extensions` is not an object; a conformant client ignores it",
      );
    } else {
      for (const [ns, value] of Object.entries(extensions)) {
        if (!isRecord(value)) {
          warnings.push(
            `plugin.json \`extensions.${ns}\` is not an object; a conformant client ignores it`,
          );
        }
      }
    }
  }

  for (const key of Object.keys(json)) {
    if (!MANIFEST_KNOWN_FIELDS.has(key)) {
      warnings.push(
        `plugin.json field \`${key}\` is not in the Agent Plugins spec (the root schema is closed — clients report and ignore it)`,
      );
    }
  }

  return { errors, warnings };
}

/** Spec cwd grammar: `./…`, `${PLUGIN_ROOT}`-rooted, or `${PLUGIN_DATA}`-rooted. */
const CWD_PATTERN = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

const RESERVED_ENV_KEYS = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

function isLocalhostUrl(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  );
}

function validateRemoteUrl(name: string, raw: unknown, errors: string[]): void {
  if (typeof raw !== "string" || raw.length === 0) {
    errors.push(`mcp.json server \`${name}\` requires a non-empty \`url\``);
    return;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    errors.push(`mcp.json server \`${name}\` \`url\` is not an absolute URL`);
    return;
  }
  if (url.username || url.password) {
    errors.push(`mcp.json server \`${name}\` \`url\` must not carry user info`);
  }
  if (url.hash) {
    errors.push(`mcp.json server \`${name}\` \`url\` must not carry a fragment`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhostUrl(url))) {
    errors.push(
      `mcp.json server \`${name}\` \`url\` must use https (http is allowed for localhost only)`,
    );
  }
}

function validateStringRecord(
  label: string,
  raw: unknown,
  errors: string[],
  reservedKeys?: Set<string>,
): void {
  if (!isRecord(raw)) {
    errors.push(`${label} must be an object of string values`);
    return;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (reservedKeys?.has(key)) {
      errors.push(`${label} must not contain the reserved key \`${key}\``);
    }
    if (typeof value !== "string") {
      errors.push(`${label} value for \`${key}\` must be a string`);
    }
  }
}

/** Validate a parsed mcp.json against the spec schema + URL/env/cwd rules. */
export function validateAgentPluginMcpConfig(json: unknown): SpecValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(json)) {
    return { errors: ["mcp.json must be a JSON object"], warnings };
  }
  if (json["$schema"] !== AGENT_PLUGIN_MCP_SCHEMA_ID) {
    errors.push(
      `mcp.json \`$schema\` must be \`${AGENT_PLUGIN_MCP_SCHEMA_ID}\` (got ${JSON.stringify(json["$schema"] ?? null)})`,
    );
  }
  const servers = json["mcpServers"];
  if (!isRecord(servers)) {
    errors.push("mcp.json requires an object `mcpServers` field");
    return { errors, warnings };
  }

  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) {
      errors.push(`mcp.json server \`${name}\` must be an object`);
      continue;
    }
    const type = raw["type"];
    if (type === "stdio") {
      if (typeof raw["command"] !== "string" || raw["command"].length === 0) {
        errors.push(`mcp.json server \`${name}\` requires a non-empty \`command\``);
      }
      if ("args" in raw) {
        const args = raw["args"];
        if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
          errors.push(`mcp.json server \`${name}\` \`args\` must be a string array`);
        }
      }
      if ("env" in raw) {
        validateStringRecord(
          `mcp.json server \`${name}\` \`env\``,
          raw["env"],
          errors,
          RESERVED_ENV_KEYS,
        );
      }
      if ("cwd" in raw) {
        if (typeof raw["cwd"] !== "string" || !CWD_PATTERN.test(raw["cwd"])) {
          errors.push(
            `mcp.json server \`${name}\` \`cwd\` must be \`./…\`, \`\${PLUGIN_ROOT}\`-rooted, or \`\${PLUGIN_DATA}\`-rooted`,
          );
        }
      }
      checkUnknownServerFields(
        name,
        raw,
        ["type", "command", "args", "env", "cwd"],
        errors,
      );
    } else if (type === "streamable-http" || type === "sse") {
      validateRemoteUrl(name, raw["url"], errors);
      if ("headers" in raw) {
        validateStringRecord(
          `mcp.json server \`${name}\` \`headers\``,
          raw["headers"],
          errors,
        );
      }
      checkUnknownServerFields(name, raw, ["type", "url", "headers"], errors);
    } else {
      errors.push(
        `mcp.json server \`${name}\` requires an explicit \`type\` of stdio, streamable-http, or sse (got ${JSON.stringify(type ?? null)})`,
      );
    }
  }

  return { errors, warnings };
}

function checkUnknownServerFields(
  name: string,
  raw: Record<string, unknown>,
  allowed: string[],
  errors: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key)) {
      errors.push(
        `mcp.json server \`${name}\` field \`${key}\` is not in the Agent Plugins spec`,
      );
    }
  }
}
