import { describe, expect, it } from "vitest";
import { sanitizeCodexAgentConfig } from "../src/codex/customAgentConfig.js";

// Regression for #127: Codex requires nickname candidates to be unique;
// duplicates must be omitted, not preserved as runtime-invalid output.
describe("nickname candidate uniqueness (#127)", () => {
  it("omits nickname_candidates containing duplicates", () => {
    expect(sanitizeCodexAgentConfig({ nickname_candidates: ["Atlas", "Atlas"] })).toEqual({
      config: {},
      omittedKeys: ["nickname_candidates"],
    });
  });

  it("preserves unique candidates unchanged", () => {
    expect(sanitizeCodexAgentConfig({ nickname_candidates: ["Atlas", "Vega"] })).toEqual({
      config: { nickname_candidates: ["Atlas", "Vega"] },
      omittedKeys: [],
    });
  });
});
