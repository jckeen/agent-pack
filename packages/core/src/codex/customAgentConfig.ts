const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const NICKNAME_RE = /^[A-Za-z0-9 _-]+$/;

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
    if (key === "model" && typeof value === "string" && value.trim() !== "") {
      config[key] = value;
    } else if (
      key === "model_reasoning_effort" &&
      typeof value === "string" &&
      REASONING_EFFORTS.has(value)
    ) {
      config[key] = value;
    } else if (
      key === "nickname_candidates" &&
      Array.isArray(value) &&
      value.length > 0 &&
      new Set(value).size === value.length &&
      value.every(
        (candidate) => typeof candidate === "string" && NICKNAME_RE.test(candidate),
      )
    ) {
      config[key] = value;
    } else {
      omittedKeys.push(key);
    }
  }

  return { config, omittedKeys: omittedKeys.sort() };
}
