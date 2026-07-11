export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isEnvVarList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "string" ||
        (isRecord(entry) &&
          typeof entry["name"] === "string" &&
          (entry["source"] === undefined ||
            entry["source"] === "local" ||
            entry["source"] === "remote") &&
          Object.keys(entry).every((key) => ["name", "source"].includes(key))),
    )
  );
}

function isToolConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (tool) =>
      isRecord(tool) &&
      Object.keys(tool).every((key) => key === "approval_mode") &&
      (tool["approval_mode"] === undefined ||
        ["auto", "prompt", "writes", "approve"].includes(String(tool["approval_mode"]))),
  );
}

export const CODEX_MCP_CONFIG_KEYS = [
  "args",
  "auth",
  "bearer_token_env_var",
  "command",
  "cwd",
  "default_tools_approval_mode",
  "disabled_tools",
  "enabled",
  "enabled_tools",
  "env_http_headers",
  "env_vars",
  "environment_id",
  "name",
  "oauth",
  "oauth_resource",
  "required",
  "scopes",
  "startup_timeout_ms",
  "startup_timeout_sec",
  "supports_parallel_tool_calls",
  "tool_timeout_sec",
  "tools",
  "url",
] as const;

export function validMcpConfigValue(key: string, value: unknown): boolean {
  if (
    [
      "bearer_token_env_var",
      "command",
      "cwd",
      "environment_id",
      "name",
      "oauth_resource",
      "url",
    ].includes(key)
  ) {
    return typeof value === "string" && value.trim().length > 0;
  }
  if (["args", "disabled_tools", "enabled_tools", "scopes"].includes(key)) {
    return isStringArray(value);
  }
  if (["enabled", "required", "supports_parallel_tool_calls"].includes(key)) {
    return typeof value === "boolean";
  }
  if (key === "startup_timeout_ms") return Number.isInteger(value) && Number(value) >= 0;
  if (["startup_timeout_sec", "tool_timeout_sec"].includes(key)) {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (key === "auth") return value === "oauth" || value === "chatgpt";
  if (key === "default_tools_approval_mode") {
    return ["auto", "prompt", "writes", "approve"].includes(String(value));
  }
  if (key === "env_http_headers") return isStringRecord(value);
  if (key === "env_vars") return isEnvVarList(value);
  if (key === "oauth") {
    return (
      isRecord(value) &&
      Object.keys(value).every((entry) => entry === "client_id") &&
      (value["client_id"] === undefined || typeof value["client_id"] === "string")
    );
  }
  if (key === "tools") return isToolConfig(value);
  return false;
}

const MCP_METADATA_FIELDS = new Set([
  "id",
  "type",
  "name",
  "description",
  "path",
  "risk_level",
  "permissions",
  "platforms",
  "codex_only_config",
  "tools_exposed",
  "warnings",
]);

function isMcpEnv(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" ||
      (isRecord(entry) &&
        Object.keys(entry).every((key) => key === "required" || key === "description") &&
        (entry["required"] === undefined || typeof entry["required"] === "boolean") &&
        (entry["description"] === undefined || typeof entry["description"] === "string")),
  );
}

function commonInvalidFields(record: Record<string, unknown>): string[] {
  const invalid: string[] = [];
  if (
    record["transport"] !== undefined &&
    !["stdio", "http", "sse"].includes(String(record["transport"]))
  ) {
    invalid.push("transport");
  }
  if (record["env"] !== undefined && !isMcpEnv(record["env"])) invalid.push("env");
  if (
    record["codex_only_config"] !== undefined &&
    !isStringArray(record["codex_only_config"])
  ) {
    invalid.push("codex_only_config");
  }
  for (const field of ["tools_exposed", "warnings"]) {
    if (record[field] !== undefined && !isStringArray(record[field])) invalid.push(field);
  }
  return invalid;
}

export function invalidCodexMcpFields(record: Record<string, unknown>): string[] {
  const allowed = new Set([
    ...MCP_METADATA_FIELDS,
    "transport",
    "env",
    ...CODEX_MCP_CONFIG_KEYS,
  ]);
  const invalid = commonInvalidFields(record);
  for (const [key, value] of Object.entries(record)) {
    if (!allowed.has(key)) invalid.push(key);
    else if (
      CODEX_MCP_CONFIG_KEYS.includes(key as (typeof CODEX_MCP_CONFIG_KEYS)[number])
    ) {
      if (!validMcpConfigValue(key, value)) invalid.push(key);
    }
  }
  return [...new Set(invalid)].sort();
}

export function invalidClaudeMcpFields(record: Record<string, unknown>): string[] {
  const allowed = new Set([
    ...MCP_METADATA_FIELDS,
    "transport",
    "command",
    "args",
    "env",
    "url",
  ]);
  const invalid = commonInvalidFields(record);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid.push(key);
  }
  if (
    record["command"] !== undefined &&
    !validMcpConfigValue("command", record["command"])
  ) {
    invalid.push("command");
  }
  if (record["args"] !== undefined && !isStringArray(record["args"])) invalid.push("args");
  if (record["url"] !== undefined && typeof record["url"] !== "string") invalid.push("url");
  return [...new Set(invalid)].sort();
}

export function invalidChatMcpFields(record: Record<string, unknown>): string[] {
  const allowed = new Set([
    ...MCP_METADATA_FIELDS,
    "transport",
    "url",
    "env",
    "auth",
    "tools",
  ]);
  const invalid = commonInvalidFields(record);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid.push(key);
  }
  if (record["url"] !== undefined && typeof record["url"] !== "string") invalid.push("url");
  if (record["tools"] !== undefined && !Array.isArray(record["tools"]))
    invalid.push("tools");
  if (record["auth"] !== undefined) {
    const auth = record["auth"];
    if (
      !isRecord(auth) ||
      typeof auth["scheme"] !== "string" ||
      (auth["scopes"] !== undefined && !isStringArray(auth["scopes"]))
    ) {
      invalid.push("auth");
    }
  }
  return [...new Set(invalid)].sort();
}
