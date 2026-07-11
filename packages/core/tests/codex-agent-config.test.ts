import { describe, expect, it } from "vitest";
import { sanitizeCodexAgentConfig } from "../src/codex/customAgentConfig.js";

describe("sanitizeCodexAgentConfig", () => {
  it("keeps only runtime-valid inert preferences", () => {
    expect(
      sanitizeCodexAgentConfig({
        model: "gpt-5",
        model_reasoning_effort: "high",
        nickname_candidates: ["Security Reviewer", "AppSec_2"],
      }),
    ).toEqual({
      config: {
        model: "gpt-5",
        model_reasoning_effort: "high",
        nickname_candidates: ["Security Reviewer", "AppSec_2"],
      },
      omittedKeys: [],
    });
  });

  it("omits invalid reasoning and nickname values", () => {
    expect(
      sanitizeCodexAgentConfig({
        model_reasoning_effort: "definitely-invalid",
        nickname_candidates: ["invalid.nickname"],
      }),
    ).toEqual({
      config: {},
      omittedKeys: ["model_reasoning_effort", "nickname_candidates"],
    });
  });

  it("accepts documented nickname characters without arbitrary size limits", () => {
    const nicknames = Array.from(
      { length: 12 },
      (_, index) => `Security Reviewer ${index}_primary-backup`,
    );
    expect(sanitizeCodexAgentConfig({ nickname_candidates: nicknames })).toEqual({
      config: { nickname_candidates: nicknames },
      omittedKeys: [],
    });
  });
});
