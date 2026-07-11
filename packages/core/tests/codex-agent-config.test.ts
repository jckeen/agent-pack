import { describe, expect, it } from "vitest";
import { sanitizeCodexAgentConfig } from "../src/codex/customAgentConfig.js";

describe("sanitizeCodexAgentConfig", () => {
  it("keeps only runtime-valid inert preferences", () => {
    expect(
      sanitizeCodexAgentConfig({
        model: "gpt-5",
        model_reasoning_effort: "high",
        nickname_candidates: ["Reviewer", "AppSec_2"],
      }),
    ).toEqual({
      config: {
        model: "gpt-5",
        model_reasoning_effort: "high",
        nickname_candidates: ["Reviewer", "AppSec_2"],
      },
      omittedKeys: [],
    });
  });

  it("omits invalid reasoning and nickname values", () => {
    expect(
      sanitizeCodexAgentConfig({
        model_reasoning_effort: "definitely-invalid",
        nickname_candidates: ["duplicate", "duplicate"],
      }),
    ).toEqual({
      config: {},
      omittedKeys: ["model_reasoning_effort", "nickname_candidates"],
    });
  });
});
