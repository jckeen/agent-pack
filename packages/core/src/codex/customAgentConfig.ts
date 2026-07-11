const SAFE_STRING_KEYS = new Set(["model", "model_reasoning_effort"]);

export interface SanitizedCodexAgentConfig {
  config: Record<string, unknown>;
  omittedKeys: string[];
}

/**
 * Keep only inert presentation/model preferences. Full Codex agent configs can
 * contain MCP commands, secrets, sandbox overrides, and provider credentials;
 * those must not bypass AgentPack's permission and executable-content gates.
 */
export function sanitizeCodexAgentConfig(
  input: Record<string, unknown>,
): SanitizedCodexAgentConfig {
  const config: Record<string, unknown> = {};
  const omittedKeys: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (SAFE_STRING_KEYS.has(key) && typeof value === "string") {
      config[key] = value;
    } else if (
      key === "nickname_candidates" &&
      Array.isArray(value) &&
      value.every((candidate) => typeof candidate === "string")
    ) {
      config[key] = value;
    } else {
      omittedKeys.push(key);
    }
  }

  return { config, omittedKeys: omittedKeys.sort() };
}
