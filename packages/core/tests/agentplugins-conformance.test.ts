import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AGENT_PLUGINS_SPEC_VERSION,
  AGENT_PLUGIN_MANIFEST_SCHEMA_ID,
  AGENT_PLUGIN_MCP_SCHEMA_ID,
  AGENTPACK_EXTENSION_NAMESPACE,
  normalizeAgentPluginName,
  validateAgentPluginName,
  validateAgentPluginManifest,
  validateAgentPluginMcpConfig,
} from "../src/exports/agentplugins.js";

const SCHEMAS_DIR = path.resolve(__dirname, "../../../schemas/agent-plugins");

function minimalManifest(): Record<string, unknown> {
  return { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_ID, name: "pr-quality" };
}

function minimalMcp(): Record<string, unknown> {
  return {
    $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
    mcpServers: {
      "docs-search": { type: "stdio", command: "docs-mcp", args: ["--stdio"] },
    },
  };
}

describe("agentplugins spec constants", () => {
  it("pins the 1.0.0 schema ids", () => {
    expect(AGENT_PLUGINS_SPEC_VERSION).toBe("1.0.0");
    expect(AGENT_PLUGIN_MANIFEST_SCHEMA_ID).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    );
    expect(AGENT_PLUGIN_MCP_SCHEMA_ID).toBe(
      "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    );
  });

  it("uses a reverse-domain AgentPack extension namespace", () => {
    expect(AGENTPACK_EXTENSION_NAMESPACE).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });

  it("vendored schema files match the pinned ids", async () => {
    const plugin = JSON.parse(
      await fs.readFile(path.join(SCHEMAS_DIR, "plugin.schema.json"), "utf8"),
    );
    const mcp = JSON.parse(
      await fs.readFile(path.join(SCHEMAS_DIR, "mcp.schema.json"), "utf8"),
    );
    expect(plugin.$id).toBe(AGENT_PLUGIN_MANIFEST_SCHEMA_ID);
    expect(mcp.$id).toBe(AGENT_PLUGIN_MCP_SCHEMA_ID);
    // The name grammar our validator ports must be the vendored schema's.
    expect(plugin.properties.name.pattern).toBe(
      "^(?!.*(?:--|\\.\\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$",
    );
  });
});

describe("validateAgentPluginName", () => {
  it("accepts spec-conformant names", () => {
    expect(validateAgentPluginName("pr-quality")).toEqual([]);
    expect(validateAgentPluginName("a")).toEqual([]);
    expect(validateAgentPluginName("scope.tool-v2")).toEqual([]);
  });

  it("rejects uppercase, edge separators, consecutive separators, and over-length", () => {
    expect(validateAgentPluginName("PR-Quality")).not.toEqual([]);
    expect(validateAgentPluginName("-pr")).not.toEqual([]);
    expect(validateAgentPluginName("pr-")).not.toEqual([]);
    expect(validateAgentPluginName("pr--quality")).not.toEqual([]);
    expect(validateAgentPluginName("pr..quality")).not.toEqual([]);
    expect(validateAgentPluginName("a".repeat(65))).not.toEqual([]);
    expect(validateAgentPluginName("")).not.toEqual([]);
  });
});

describe("normalizeAgentPluginName", () => {
  it("maps arbitrary slugs onto the spec grammar", () => {
    expect(validateAgentPluginName(normalizeAgentPluginName("PR Quality!"))).toEqual([]);
    expect(normalizeAgentPluginName("PR Quality!")).toBe("pr-quality");
    expect(validateAgentPluginName(normalizeAgentPluginName("--weird__Name--"))).toEqual(
      [],
    );
  });
});

describe("validateAgentPluginManifest", () => {
  it("accepts a minimal manifest", () => {
    const { errors, warnings } = validateAgentPluginManifest(minimalManifest());
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("requires $schema to be the pinned id", () => {
    const { errors } = validateAgentPluginManifest({ name: "x" });
    expect(errors.join("\n")).toMatch(/\$schema/);
    const wrong = validateAgentPluginManifest({
      $schema: "https://agent-plugins.org/schemas/9.9.9/plugin.schema.json",
      name: "x",
    });
    expect(wrong.errors.join("\n")).toMatch(/\$schema/);
  });

  it("requires a grammar-conformant name", () => {
    const { errors } = validateAgentPluginManifest({
      ...minimalManifest(),
      name: "Bad--Name",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("reports unknown top-level fields as warnings, not errors (spec: report and ignore)", () => {
    const { errors, warnings } = validateAgentPluginManifest({
      ...minimalManifest(),
      hooks: {},
      commands: [],
    });
    expect(errors).toEqual([]);
    expect(warnings.join("\n")).toMatch(/hooks/);
    expect(warnings.join("\n")).toMatch(/commands/);
  });

  it("validates author shape and extensions namespaces", () => {
    const bad = validateAgentPluginManifest({
      ...minimalManifest(),
      author: { name: "A", twitter: "@a" },
      extensions: { "dev.agentpack": "not-an-object" },
    });
    expect(bad.errors.join("\n")).toMatch(/author/);
    expect(bad.warnings.join("\n")).toMatch(/extensions/);
  });
});

describe("validateAgentPluginMcpConfig", () => {
  it("accepts a minimal stdio config", () => {
    const { errors } = validateAgentPluginMcpConfig(minimalMcp());
    expect(errors).toEqual([]);
  });

  it("requires $schema and mcpServers", () => {
    expect(validateAgentPluginMcpConfig({}).errors.length).toBeGreaterThan(0);
    expect(
      validateAgentPluginMcpConfig({ $schema: AGENT_PLUGIN_MCP_SCHEMA_ID }).errors
        .length,
    ).toBeGreaterThan(0);
  });

  it("requires an explicit server type and per-type required fields", () => {
    const noType = validateAgentPluginMcpConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
      mcpServers: { s: { command: "x" } },
    });
    expect(noType.errors.join("\n")).toMatch(/type/);
    const noUrl = validateAgentPluginMcpConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
      mcpServers: { s: { type: "streamable-http" } },
    });
    expect(noUrl.errors.join("\n")).toMatch(/url/);
  });

  it("rejects reserved env keys and requires https for non-localhost remotes", () => {
    const reserved = validateAgentPluginMcpConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
      mcpServers: {
        s: { type: "stdio", command: "x", env: { PLUGIN_ROOT: "/tmp" } },
      },
    });
    expect(reserved.errors.join("\n")).toMatch(/PLUGIN_ROOT/);
    const insecure = validateAgentPluginMcpConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
      mcpServers: { s: { type: "sse", url: "http://example.com/mcp" } },
    });
    expect(insecure.errors.join("\n")).toMatch(/https/i);
    const localhost = validateAgentPluginMcpConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
      mcpServers: { s: { type: "streamable-http", url: "http://localhost:3999/mcp" } },
    });
    expect(localhost.errors).toEqual([]);
  });

  it("rejects a cwd outside plugin-relative / PLUGIN_ROOT / PLUGIN_DATA forms", () => {
    const bad = validateAgentPluginMcpConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
      mcpServers: { s: { type: "stdio", command: "x", cwd: "/etc" } },
    });
    expect(bad.errors.join("\n")).toMatch(/cwd/);
    const ok = validateAgentPluginMcpConfig({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID,
      mcpServers: { s: { type: "stdio", command: "x", cwd: "${PLUGIN_ROOT}/srv" } },
    });
    expect(ok.errors).toEqual([]);
  });
});
