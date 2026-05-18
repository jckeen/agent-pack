import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { planInstall, diffPlan } from "../src/install/index.js";

const EXAMPLE_PACK = path.resolve(__dirname, "../../../examples/pr-quality");
const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

async function tempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-diff-test-"));
}

describe("diffPlan", () => {
  it("produces entries for created files", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    const entries = await diffPlan(plan);
    expect(entries.some((e) => e.status === "create")).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("includes a unified diff for conflicts", async () => {
    const dir = await tempProject();
    await fs.writeFile(path.join(dir, "AGENTS.md"), "user owned\n");
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    const entries = await diffPlan(plan);
    const c = entries.find((e) => e.path === "AGENTS.md" && e.status === "conflict");
    expect(c?.diff).toMatch(/user owned/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
