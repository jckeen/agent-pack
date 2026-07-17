import { describe, expect, it } from "vitest";
import { buildManifest } from "../src/importer/buildManifest.js";
import { parseClaudeMd } from "../src/importer/parseClaudeMd.js";

const OPTS = { id: "acme.loss-detection" } as const;

// Regression for #126: `bulletsToBehavior` accepts `+`, numbered items, and
// continuation lines, so the loss detector must recognize the same shapes —
// a lossless list must not warn or downgrade the source's compatibility.
describe("loss detection matches the bullet parser (#126)", () => {
  it("imports numbered and wrapped bullets with no loss warning", () => {
    const text = [
      "## Security",
      "",
      "1. Rotate credentials quarterly.",
      "2. Prefer short-lived tokens",
      "   wherever the provider supports them.",
      "",
      "+ Never commit secrets",
      "  to any tracked file.",
    ].join("\n");
    const parsed = parseClaudeMd(text);
    const { manifest, warnings } = buildManifest(parsed, {
      ...OPTS,
      source: "claude-code",
    });
    expect(warnings).toEqual([]);
    expect(manifest.compatibility.targets["claude-code"]?.status).toBe("supported");
  });

  it("still warns when genuine prose sits outside the list items", () => {
    const text = [
      "## Security",
      "",
      "This paragraph is real prose that structured rule output drops.",
      "",
      "1. Rotate credentials quarterly.",
    ].join("\n");
    const parsed = parseClaudeMd(text);
    const { manifest, warnings } = buildManifest(parsed, {
      ...OPTS,
      source: "claude-code",
    });
    expect(
      warnings.some((warning) => /prose outside list items/.test(warning.message)),
    ).toBe(true);
    expect(manifest.compatibility.targets["claude-code"]?.status).toBe("partial");
  });
});
