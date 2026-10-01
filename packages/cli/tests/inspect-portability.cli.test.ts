import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const CLI = path.join(ROOT, "packages/cli/dist/index.js");
const EXAMPLE = path.join(ROOT, "examples/pr-quality");
const run = (args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

// Issue #273: the portability model describes Claude surfaces only. `inspect`
// is target-neutral, so its output must say so instead of reading as a verdict
// for Codex, Cursor, ChatGPT, or generic output.
describe("inspect portability labels", () => {
  const output = run(["inspect", EXAMPLE, "--profile", "safe"]);

  it("scopes the reach summary to Claude surfaces", () => {
    expect(output).toContain("Portability across Claude surfaces");
    expect(output).not.toMatch(/^Portability — overall reach/m);
  });

  it("says the labels are not a verdict for other targets or a runtime check", () => {
    expect(output).toMatch(/Claude surfaces only/);
    expect(output).toMatch(/agentpack plan --target/);
    expect(output).toMatch(/by atom type/);
  });
});
