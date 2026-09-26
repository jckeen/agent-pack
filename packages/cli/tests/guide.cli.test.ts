import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const CLI = path.join(ROOT, "packages/cli/dist/index.js");
let temp: string;
const run = (args: string[], cwd = temp) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

type Route = {
  id: string;
  commands: string[][];
  artifacts: string[];
  nextSteps: string[];
  limitations: string[];
  sources: string[];
};
beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-guide-"));
});
afterAll(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

describe("consumer surface guide", () => {
  it("lists routes without a manifest or filesystem changes", async () => {
    const before = await fs.readdir(temp);
    const output = run(["guide"]);
    for (const surface of ["chatgpt", "chatgpt-project", "claude", "claude-plugin"]) {
      expect(output).toContain(surface);
    }
    expect(output).toContain("manual");
    expect(await fs.readdir(temp)).toEqual(before);
  });

  it("rejects unknown surfaces instead of choosing a fallback", () => {
    expect(() => run(["guide", "unknown", "--json"])).toThrow();
  });

  it("offers machine-readable routes with manual steps and source links", () => {
    const guide = JSON.parse(run(["guide", "--json"])) as { routes: Route[] };
    expect(guide.routes.map((route) => route.id)).toEqual([
      "chatgpt",
      "chatgpt-project",
      "claude",
      "claude-plugin",
    ]);
    for (const route of guide.routes) {
      expect(route.nextSteps.length).toBeGreaterThan(0);
      expect(route.limitations.length).toBeGreaterThan(0);
      expect(route.sources.every((url) => url.startsWith("https://"))).toBe(true);
    }
  });

  for (const surface of ["chatgpt", "chatgpt-project", "claude", "claude-plugin"]) {
    it(`${surface}: advertised starter export produces useful artifacts`, async () => {
      const { routes } = JSON.parse(run(["guide", surface, "--json"])) as {
        routes: Route[];
      };
      expect(routes).toHaveLength(1);
      const route = routes[0]!;
      const outputDir = path.join(temp, surface);
      for (const args of route.commands) {
        const resolved = args.map((arg, i) => {
          if (arg === "examples/portable-workflow") return path.join(ROOT, arg);
          if (args[i - 1] === "--out") return outputDir;
          return arg;
        });
        run(resolved);
      }
      for (const file of route.artifacts) await fs.access(path.join(outputDir, file));
      const contentPath =
        surface === "chatgpt-project"
          ? "project-instructions.md"
          : surface === "claude"
            ? "project-instructions.md"
            : "skills/research-brief/SKILL.md";
      expect(await fs.readFile(path.join(outputDir, contentPath), "utf8")).toContain(
        "Separate observations from inferences",
      );
      if (surface === "chatgpt-project") {
        expect(route.limitations.join(" ")).toMatch(/skill.*not|not.*skill/i);
      }
    });
  }
});
