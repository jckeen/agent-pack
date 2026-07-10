import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = path.resolve(__dirname, "../dist/index.js");
const REPO_ROOT = path.resolve(__dirname, "../../..");

const TMP_ROOT = path.join(os.tmpdir(), `agentpack-import-test-${Date.now()}`);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(
  args: string[],
  options: { cwd?: string; stdin?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_ENTRY, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

const FIXTURE = [
  "---",
  "title: ignore me",
  "---",
  "# Team Defaults",
  "",
  "## Working Style",
  "",
  "Plan before non-trivial work.",
  "",
  "## Git",
  "",
  "- Commit only when asked.",
  "- Never force-push to shared branches.",
  "",
  "## External Reference",
  "",
  "@~/dev/other/CLAUDE.md",
  "",
  "Keep this body.",
].join("\n");

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("agentpack import", () => {
  it("imports a fixture and the output validates with exit 0", async () => {
    const fixturePath = path.join(TMP_ROOT, "CLAUDE.md");
    const outDir = path.join(TMP_ROOT, "out");
    await fs.writeFile(fixturePath, FIXTURE, "utf8");

    const imp = await run([
      "import",
      fixturePath,
      "--out",
      outDir,
      "--id",
      "acme.team-defaults",
      "--name",
      "Team Defaults",
    ]);
    expect(imp.code).toBe(0);
    // @import directive surfaced as a warning.
    expect(imp.stdout + imp.stderr).toContain("@import");

    // Manifest + atom files exist.
    await fs.access(path.join(outDir, "AGENTPACK.yaml"));
    await fs.access(path.join(outDir, "atoms/rules/git.yaml"));
    await fs.access(path.join(outDir, "atoms/instructions/working-style.md"));

    const validate = await run(["validate", outDir]);
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("✓ Manifest is valid.");
  });

  it("reads from stdin when path is `-`", async () => {
    const outDir = path.join(TMP_ROOT, "out-stdin");
    const imp = await run(["import", "-", "--out", outDir, "--id", "acme.from-stdin"], {
      stdin: "## Working Style\n\nbody\n",
    });
    expect(imp.code).toBe(0);
    const validate = await run(["validate", outDir]);
    expect(validate.code).toBe(0);
  });

  it("exits 2 when --id is missing", async () => {
    const fixturePath = path.join(TMP_ROOT, "CLAUDE.md");
    const r = await run(["import", fixturePath, "--out", path.join(TMP_ROOT, "x")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--id");
  });

  it("exits 2 when --id is malformed", async () => {
    const fixturePath = path.join(TMP_ROOT, "CLAUDE.md");
    const r = await run([
      "import",
      fixturePath,
      "--out",
      path.join(TMP_ROOT, "y"),
      "--id",
      "nodot",
    ]);
    expect(r.code).toBe(2);
  });

  it("exits 2 when --from is unknown", async () => {
    const r = await run([
      "import",
      TMP_ROOT,
      "--from",
      "bogus",
      "--id",
      "acme.team",
      "--out",
      path.join(TMP_ROOT, "z"),
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--from");
  });

  it("imports a Codex setup directory with --from codex and validates", async () => {
    const codexFixture = path.resolve(__dirname, "../../core/tests/fixtures/codex");
    const outDir = path.join(TMP_ROOT, "out-codex");
    const imp = await run([
      "import",
      codexFixture,
      "--from",
      "codex",
      "--out",
      outDir,
      "--id",
      "acme.codex",
      "--name",
      "Acme Codex",
    ]);
    expect(imp.code).toBe(0);

    // Manifest + Codex-native atom files exist.
    await fs.access(path.join(outDir, "AGENTPACK.yaml"));
    await fs.access(path.join(outDir, "atoms/skills/code-review/SKILL.md"));
    await fs.access(path.join(outDir, "atoms/mcp/github.yaml"));

    const validate = await run(["validate", outDir]);
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("✓ Manifest is valid.");
  });

  it("imports a Claude Code config directory with --from claude-code and validates", async () => {
    const ccFixture = path.resolve(__dirname, "../../core/tests/fixtures/claude-code");
    const outDir = path.join(TMP_ROOT, "out-claude-code");
    const imp = await run([
      "import",
      ccFixture,
      "--from",
      "claude-code",
      "--out",
      outDir,
      "--id",
      "keen.workstation",
      "--name",
      "Keen Workstation",
    ]);
    expect(imp.code).toBe(0);

    // Manifest + native atom files across multiple atom types exist. Subagents
    // are carried as verbatim `.md` (frontmatter + prompt), not YAML descriptors.
    await fs.access(path.join(outDir, "AGENTPACK.yaml"));
    await fs.access(path.join(outDir, "atoms/skills/code-review/SKILL.md"));
    await fs.access(path.join(outDir, "atoms/subagents/security-reviewer.md"));

    const validate = await run(["validate", outDir]);
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("✓ Manifest is valid.");

    // The credential store is never packaged.
    await expect(fs.access(path.join(outDir, ".credentials.json"))).rejects.toThrow();
  });

  it("imports a ChatGPT-GPT bundle with --from chatgpt-gpt and validates", async () => {
    const bundle = path.resolve(__dirname, "../../core/tests/fixtures/chatgpt");
    const outDir = path.join(TMP_ROOT, "out-chatgpt");
    const imp = await run([
      "import",
      bundle,
      "--from",
      "chatgpt-gpt",
      "--out",
      outDir,
      "--id",
      "acme.support-triage",
      "--name",
      "Support Triage",
    ]);
    expect(imp.code).toBe(0);
    // Honest can't-cross + human-judgment guidance is surfaced.
    expect(imp.stdout).toContain("Human-judgment steps");
    expect(imp.stdout).toContain("managed vector-store retrieval");

    await fs.access(path.join(outDir, "AGENTPACK.yaml"));
    await fs.access(path.join(outDir, "atoms/context/knowledge/refund-policy.md"));

    const validate = await run(["validate", outDir]);
    expect(validate.code).toBe(0);
    expect(validate.stdout).toContain("✓ Manifest is valid.");
  });
});

// ---------------------------------------------------------------------------
// Sync S3 (#112): `import --into <pack-dir> [--diff]` — fold live-config edits
// back into an existing imported pack. `--diff` is a zero-write preview
// (exit 0 = in sync, 2 = differences); without it the pack is updated in
// place, preserving hand-edited metadata/profiles/exports.
// ---------------------------------------------------------------------------
describe("agentpack import --into (fold live edits back into a pack)", () => {
  async function seedLiveDir(name: string): Promise<string> {
    const live = path.join(TMP_ROOT, name);
    await fs.mkdir(path.join(live, "skills/code-review"), { recursive: true });
    await fs.writeFile(
      path.join(live, "CLAUDE.md"),
      "# Workstation\n\n## Notes\n\nAlways leave a note.\n",
    );
    await fs.writeFile(
      path.join(live, "skills/code-review/SKILL.md"),
      "---\nname: code-review\ndescription: Reviews code.\n---\n\n# Code Review\n\nCheck the diff.\n",
    );
    return live;
  }

  /** path → size map for the zero-write assertion. */
  async function snapshot(root: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    async function walk(dir: string): Promise<void> {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else out.set(path.relative(root, abs), (await fs.stat(abs)).size);
      }
    }
    await walk(root);
    return out;
  }

  it("round trip: --diff previews with zero writes (exit 2), --into applies, --diff then exits 0", async () => {
    const live = await seedLiveDir("into-live");
    const packDir = path.join(TMP_ROOT, "into-pack");
    const imp = await run([
      "import",
      live,
      "--from",
      "claude-code",
      "--out",
      packDir,
      "--id",
      "me.workstation",
    ]);
    expect(imp.code, imp.stderr).toBe(0);

    // Nothing changed yet: --diff reports in-sync with exit 0.
    const clean = await run([
      "import",
      live,
      "--from",
      "claude-code",
      "--into",
      packDir,
      "--diff",
    ]);
    expect(clean.code, clean.stderr + clean.stdout).toBe(0);

    // Live edits: change the skill body, add a brand-new skill.
    await fs.writeFile(
      path.join(live, "skills/code-review/SKILL.md"),
      "---\nname: code-review\ndescription: Reviews code.\n---\n\n# Code Review\n\nCheck the diff twice.\n",
    );
    await fs.mkdir(path.join(live, "skills/deploy"), { recursive: true });
    await fs.writeFile(
      path.join(live, "skills/deploy/SKILL.md"),
      "---\nname: deploy\ndescription: Deploys safely.\n---\n\n# Deploy\n\nShip it.\n",
    );

    // --diff: exit 2, names the changed paths, writes NOTHING.
    const before = await snapshot(packDir);
    const diff = await run([
      "import",
      live,
      "--from",
      "claude-code",
      "--into",
      packDir,
      "--diff",
    ]);
    expect(diff.code, diff.stderr + diff.stdout).toBe(2);
    expect(diff.stdout).toContain("atoms/skills/code-review/SKILL.md");
    expect(diff.stdout).toContain("atoms/skills/deploy/SKILL.md");
    const after = await snapshot(packDir);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());

    // --into (no --diff): applies the fold, pack validates, --diff goes quiet.
    const fold = await run(["import", live, "--from", "claude-code", "--into", packDir]);
    expect(fold.code, fold.stderr + fold.stdout).toBe(0);
    expect(
      await fs.readFile(path.join(packDir, "atoms/skills/code-review/SKILL.md"), "utf8"),
    ).toContain("Check the diff twice.");
    await fs.access(path.join(packDir, "atoms/skills/deploy/SKILL.md"));
    const validate = await run(["validate", packDir]);
    expect(validate.code, validate.stderr).toBe(0);
    const recheck = await run([
      "import",
      live,
      "--from",
      "claude-code",
      "--into",
      packDir,
      "--diff",
    ]);
    expect(recheck.code, recheck.stderr + recheck.stdout).toBe(0);
  });

  it("preserves hand-edited metadata (version, description) across a fold", async () => {
    const live = await seedLiveDir("into-meta-live");
    const packDir = path.join(TMP_ROOT, "into-meta-pack");
    await run([
      "import",
      live,
      "--from",
      "claude-code",
      "--out",
      packDir,
      "--id",
      "me.meta",
    ]);
    // Hand-edit the manifest the way a pack author would.
    const manifestPath = path.join(packDir, "AGENTPACK.yaml");
    const edited = (await fs.readFile(manifestPath, "utf8"))
      .replace('version: "0.1.0"', 'version: "0.2.0"')
      .replace("version: 0.1.0", "version: 0.2.0")
      .replace("description: Imported from Claude Code", "description: My dotfiles pack");
    await fs.writeFile(manifestPath, edited);

    await fs.writeFile(
      path.join(live, "CLAUDE.md"),
      "# Workstation\n\n## Notes\n\nAlways leave TWO notes.\n",
    );
    const fold = await run(["import", live, "--from", "claude-code", "--into", packDir]);
    expect(fold.code, fold.stderr + fold.stdout).toBe(0);
    const rewritten = await fs.readFile(manifestPath, "utf8");
    expect(rewritten).toContain("0.2.0");
    expect(rewritten).toContain("My dotfiles pack");
    expect(
      await fs.readFile(path.join(packDir, "atoms/instructions/notes.md"), "utf8"),
    ).toContain("TWO notes");
  });

  it("removes stale atom files when the live config dropped them", async () => {
    const live = await seedLiveDir("into-rm-live");
    const packDir = path.join(TMP_ROOT, "into-rm-pack");
    await run([
      "import",
      live,
      "--from",
      "claude-code",
      "--out",
      packDir,
      "--id",
      "me.remove",
    ]);
    await fs.rm(path.join(live, "skills/code-review"), { recursive: true });
    const fold = await run(["import", live, "--from", "claude-code", "--into", packDir]);
    expect(fold.code, fold.stderr + fold.stdout).toBe(0);
    await expect(
      fs.access(path.join(packDir, "atoms/skills/code-review/SKILL.md")),
    ).rejects.toThrow();
    const validate = await run(["validate", packDir]);
    expect(validate.code, validate.stderr).toBe(0);
  });

  it("usage errors: --diff without --into, --id with --into, --into without a pack", async () => {
    const live = await seedLiveDir("into-usage-live");
    const r1 = await run(["import", live, "--from", "claude-code", "--diff"]);
    expect(r1.code).toBe(2);
    const r2 = await run([
      "import",
      live,
      "--from",
      "claude-code",
      "--into",
      path.join(TMP_ROOT, "into-usage-pack"),
      "--id",
      "me.x",
    ]);
    expect(r2.code).toBe(2);
    const r3 = await run([
      "import",
      live,
      "--from",
      "claude-code",
      "--into",
      path.join(TMP_ROOT, "does-not-exist-pack"),
    ]);
    expect(r3.code).not.toBe(0);
  });
});
