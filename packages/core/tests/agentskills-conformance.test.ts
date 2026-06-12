/**
 * Agent Skills spec conformance gate.
 *
 * Validates that every SKILL.md AgentPack emits conforms to the Anthropic
 * Agent Skills specification (https://agentskills.io — spec text at
 * agentskills/agentskills → docs/specification.mdx, reference validator at
 * skills-ref/src/skills_ref/validator.py).
 *
 * The checks here are a TypeScript port of the skills-ref validator rules
 * (validateSkillMdContent). Tradeoff: wiring the official Python validator
 * into CI would add a Python toolchain + network fetch to every run for the
 * same six rules; the port is small and the rules are stable, so we
 * re-implement and cross-check manually against `uvx --from
 * "git+https://github.com/agentskills/agentskills#subdirectory=skills-ref"
 * skills-ref validate <dir>` when the spec revs. Audited 2026-06-12 against
 * spec commit 5d4c1fd.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  conformSkillMd,
  exportPack,
  exportPlugin,
  normalizeSkillSlug,
  renderSkillMd,
  validateSkillAtoms,
  validateSkillMdContent,
  type TargetPlatform,
} from "../src/index.js";
import { loadManifest } from "../src/parser/loadManifest.js";

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");

const tmpRoot = path.join(os.tmpdir(), `agentpack-skills-spec-${Date.now()}`);

beforeAll(async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function findSkillDirs(root: string): Promise<string[]> {
  const dirs: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.name === "SKILL.md" || e.name === "skill.md") {
        dirs.push(path.dirname(abs));
      }
    }
  }
  await walk(root);
  return dirs.sort();
}

async function expectAllSkillsConformant(outDir: string): Promise<void> {
  const skillDirs = await findSkillDirs(outDir);
  expect(skillDirs.length).toBeGreaterThan(0);
  for (const dir of skillDirs) {
    const content = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
    const errors = validateSkillMdContent(content, path.basename(dir));
    expect(errors, `non-conformant SKILL.md in ${dir}`).toEqual([]);
  }
}

// ---------------------------------------------------------------------------
// validateSkillMdContent — TS port of skills-ref rules
// ---------------------------------------------------------------------------

describe("validateSkillMdContent", () => {
  const valid = `---\nname: my-skill\ndescription: Does a thing. Use when testing.\n---\n\nBody.\n`;

  it("accepts a minimal conformant SKILL.md", () => {
    expect(validateSkillMdContent(valid, "my-skill")).toEqual([]);
  });

  it("accepts all optional spec fields", () => {
    const content = [
      "---",
      "name: my-skill",
      "description: Does a thing.",
      "license: MIT",
      "compatibility: Requires git",
      "allowed-tools: Read Bash(git:*)",
      "metadata:",
      "  author: someone",
      '  version: "1.0"',
      "---",
      "",
      "Body.",
    ].join("\n");
    expect(validateSkillMdContent(content, "my-skill")).toEqual([]);
  });

  it("rejects missing frontmatter", () => {
    expect(validateSkillMdContent("# No frontmatter\n", "x")).not.toEqual([]);
  });

  it("rejects unknown top-level fields", () => {
    const content = `---\nname: my-skill\ndescription: D.\nversion: "2.0"\n---\n`;
    const errors = validateSkillMdContent(content, "my-skill");
    expect(errors.join(" ")).toMatch(/version/);
  });

  it("rejects uppercase, consecutive-hyphen, and edge-hyphen names", () => {
    for (const name of ["My-Skill", "my--skill", "-my-skill", "my-skill-"]) {
      const content = `---\nname: ${name}\ndescription: D.\n---\n`;
      expect(
        validateSkillMdContent(content, name),
        `name ${name} should be rejected`,
      ).not.toEqual([]);
    }
  });

  it("rejects underscore and dot in names", () => {
    const content = `---\nname: my_skill.v2\ndescription: D.\n---\n`;
    expect(validateSkillMdContent(content, "my_skill.v2")).not.toEqual([]);
  });

  it("rejects a name/directory mismatch", () => {
    const errors = validateSkillMdContent(valid, "other-dir");
    expect(errors.join(" ")).toMatch(/match/i);
  });

  it("rejects over-length name, description, and compatibility", () => {
    const longName = "a".repeat(65);
    expect(
      validateSkillMdContent(`---\nname: ${longName}\ndescription: D.\n---\n`, longName),
    ).not.toEqual([]);
    expect(
      validateSkillMdContent(
        `---\nname: my-skill\ndescription: ${"d".repeat(1025)}\n---\n`,
        "my-skill",
      ),
    ).not.toEqual([]);
    expect(
      validateSkillMdContent(
        `---\nname: my-skill\ndescription: D.\ncompatibility: ${"c".repeat(501)}\n---\n`,
        "my-skill",
      ),
    ).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeSkillSlug
// ---------------------------------------------------------------------------

describe("normalizeSkillSlug", () => {
  it("lowercases and replaces illegal characters with hyphens", () => {
    expect(normalizeSkillSlug("My_Skill.v2")).toBe("my-skill-v2");
  });

  it("collapses consecutive hyphens and trims edges", () => {
    expect(normalizeSkillSlug("--a__b--")).toBe("a-b");
  });

  it("truncates to 64 chars without a trailing hyphen", () => {
    const out = normalizeSkillSlug(`${"a".repeat(63)}-b`);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.endsWith("-")).toBe(false);
  });

  it("falls back to `skill` when nothing survives", () => {
    expect(normalizeSkillSlug("___")).toBe("skill");
  });

  it("is idempotent on conformant slugs", () => {
    expect(normalizeSkillSlug("code-review")).toBe("code-review");
  });
});

// ---------------------------------------------------------------------------
// renderSkillMd — YAML-safe synthesis
// ---------------------------------------------------------------------------

describe("renderSkillMd", () => {
  it("emits parseable YAML when the description contains `: `", () => {
    const content = renderSkillMd(
      { name: "my-skill", description: "Synthesized fallback: tests colons, etc." },
      "Body.",
    );
    expect(validateSkillMdContent(content, "my-skill")).toEqual([]);
  });

  it("carries spec-extra fields under metadata, not top-level", () => {
    const content = renderSkillMd(
      {
        name: "my-skill",
        description: "D.",
        metadata: { "agentpack-atom": "skill:my-skill" },
      },
      "Body.",
    );
    expect(validateSkillMdContent(content, "my-skill")).toEqual([]);
    expect(content).toMatch(/agentpack-atom/);
  });

  it("clamps over-length descriptions to the spec limit", () => {
    const content = renderSkillMd(
      { name: "my-skill", description: "d".repeat(2000) },
      "Body.",
    );
    expect(validateSkillMdContent(content, "my-skill")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// conformSkillMd — pass-through normalization
// ---------------------------------------------------------------------------

describe("conformSkillMd", () => {
  const fallback = { name: "fallback-name", description: "Fallback description." };

  it("returns conformant content byte-identical", () => {
    const content = `---\nname: my-skill\ndescription: D.\n---\n\nBody.\n`;
    const result = conformSkillMd(content, "my-skill", fallback);
    expect(result.content).toBe(content);
    expect(result.warnings).toEqual([]);
  });

  it("rewrites the name to match the emitted directory", () => {
    const content = `---\nname: other-name\ndescription: D.\n---\n\nBody.\n`;
    const result = conformSkillMd(content, "my-skill", fallback);
    expect(validateSkillMdContent(result.content, "my-skill")).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/other-name/);
    expect(result.content).toMatch(/Body\./);
  });

  it("relocates unknown top-level fields under metadata", () => {
    const content = `---\nname: my-skill\ndescription: D.\nversion: "2.0"\nauthor: someone\n---\n\nBody.\n`;
    const result = conformSkillMd(content, "my-skill", fallback);
    expect(validateSkillMdContent(result.content, "my-skill")).toEqual([]);
    expect(result.content).toMatch(/version/);
    expect(result.content).toMatch(/someone/);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("synthesizes frontmatter from the fallback when parsing fails", () => {
    const content = "# Just a heading\n\nNo frontmatter at all.\n";
    const result = conformSkillMd(content, "fallback-name", fallback);
    expect(validateSkillMdContent(result.content, "fallback-name")).toEqual([]);
    expect(result.content).toMatch(/No frontmatter at all\./);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Emitted-output conformance gate (the CI tripwire)
// ---------------------------------------------------------------------------

const SKILL_EMITTING_TARGETS: TargetPlatform[] = ["claude-code", "codex", "generic"];

describe("emitted skills conform to the Agent Skills spec", () => {
  for (const target of SKILL_EMITTING_TARGETS) {
    it(`example pack → ${target} (standard)`, async () => {
      const outDir = path.join(tmpRoot, `example-${target}`);
      await exportPack({ source: EXAMPLE, target, profile: "standard", outDir });
      await expectAllSkillsConformant(outDir);
    });
  }

  it("example pack → plugin layout (incl. guidance skill)", async () => {
    const outDir = path.join(tmpRoot, "example-plugin");
    await exportPlugin({ source: EXAMPLE, outDir });
    await expectAllSkillsConformant(outDir);
  });
});

// ---------------------------------------------------------------------------
// Adversarial pack: hostile names, colons in descriptions, non-spec sources
// ---------------------------------------------------------------------------

async function writeAdversarialPack(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "atoms/skills/odd-name"), { recursive: true });
  await fs.mkdir(path.join(root, "atoms/skills/extra-fields"), { recursive: true });
  await fs.writeFile(
    path.join(root, "AGENTPACK.yaml"),
    [
      'agentpack: "1.0"',
      "metadata:",
      '  id: "agentpack.adversarial"',
      '  name: "Adversarial: Skills Fixture"',
      '  slug: "adversarial"',
      '  description: "Fixture: colons, hostile slugs, non-spec skill sources."',
      '  version: "0.0.1"',
      '  publisher: "agentpack"',
      "compatibility:",
      "  targets:",
      "    claude-code: { status: supported }",
      "    codex: { status: supported }",
      "    generic: { status: supported }",
      "permissions: {}",
      "profiles:",
      "  safe:",
      '    include: ["*"]',
      "atoms:",
      '  - id: "skill:My_Skill.v2"',
      "    type: skill",
      '    name: "My Skill"',
      '    description: "Synthesized fallback: tests colon and hostile slug."',
      '    path: "atoms/skills/does-not-exist"',
      "    risk_level: low",
      '  - id: "skill:odd-name"',
      "    type: skill",
      '    name: "Odd Name"',
      '    description: "SKILL.md name mismatches the emitted directory."',
      '    path: "atoms/skills/odd-name"',
      "    risk_level: low",
      '  - id: "skill:extra-fields"',
      "    type: skill",
      '    name: "Extra Fields"',
      '    description: "SKILL.md carries non-spec top-level fields."',
      '    path: "atoms/skills/extra-fields"',
      "    risk_level: low",
      '  - id: "command:do_thing"',
      "    type: command",
      '    name: "Do Thing"',
      '    description: "Command emitted as a codex skill: colon included."',
      '    path: "atoms/skills/odd-name/SKILL.md"',
      "    risk_level: low",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "atoms/skills/odd-name/SKILL.md"),
    `---\nname: totally-different-name\ndescription: Name does not match directory.\n---\n\nOdd body.\n`,
  );
  await fs.writeFile(
    path.join(root, "atoms/skills/extra-fields/SKILL.md"),
    `---\nname: extra-fields\ndescription: Has non-spec fields.\nversion: "2.0"\nauthor: someone\n---\n\nExtra body.\n`,
  );
}

describe("adversarial pack still emits conformant skills", () => {
  let packRoot: string;

  beforeAll(async () => {
    packRoot = path.join(tmpRoot, "adversarial-pack");
    await writeAdversarialPack(packRoot);
  });

  for (const target of SKILL_EMITTING_TARGETS) {
    it(`adversarial pack → ${target}`, async () => {
      const outDir = path.join(tmpRoot, `adversarial-${target}`);
      const result = await exportPack({
        source: packRoot,
        target,
        profile: "safe",
        outDir,
        allowMissingBodies: true,
      });
      await expectAllSkillsConformant(outDir);
      // The conformance rewrites must be surfaced, not silent.
      expect(result.plan.warnings.join("\n")).toMatch(/totally-different-name/);
    });
  }

  it("normalizes hostile slugs in emitted paths", async () => {
    const outDir = path.join(tmpRoot, "adversarial-paths");
    await exportPack({
      source: packRoot,
      target: "claude-code",
      profile: "safe",
      outDir,
      allowMissingBodies: true,
    });
    const dirs = (await findSkillDirs(outDir)).map((d) => path.basename(d));
    expect(dirs).toContain("my-skill-v2");
    expect(dirs).not.toContain("My_Skill.v2");
  });
});

// ---------------------------------------------------------------------------
// Ingestion: spec-conformant skill folders round-trip losslessly
// ---------------------------------------------------------------------------

describe("spec skill ingestion", () => {
  let packRoot: string;
  const specSkill = [
    "---",
    "name: spec-skill",
    "description: A fully spec-conformant skill with every optional field.",
    "license: Apache-2.0",
    "compatibility: Requires git and network access",
    "allowed-tools: Read Bash(git:*)",
    "metadata:",
    "  author: upstream-org",
    '  version: "3.1"',
    "---",
    "",
    "## Instructions",
    "",
    "Run [the script](scripts/run.sh) and consult [the reference](references/REF.md).",
    "",
  ].join("\n");

  beforeAll(async () => {
    packRoot = path.join(tmpRoot, "ingest-pack");
    const skillDir = path.join(packRoot, "atoms/skills/spec-skill");
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), specSkill);
    await fs.writeFile(path.join(skillDir, "scripts/run.sh"), "#!/bin/sh\necho ok\n");
    await fs.writeFile(path.join(skillDir, "references/REF.md"), "# Ref\n");
    await fs.writeFile(
      path.join(packRoot, "AGENTPACK.yaml"),
      [
        'agentpack: "1.0"',
        "metadata:",
        '  id: "agentpack.ingest"',
        '  name: "Ingest Fixture"',
        '  slug: "ingest"',
        '  description: "Wraps an upstream Agent Skills folder as a skill atom."',
        '  version: "0.0.1"',
        '  publisher: "agentpack"',
        "compatibility:",
        "  targets:",
        "    claude-code: { status: supported }",
        "permissions: {}",
        "profiles:",
        "  safe:",
        '    include: ["*"]',
        "atoms:",
        '  - id: "skill:spec-skill"',
        "    type: skill",
        '    name: "Spec Skill"',
        '    description: "Upstream spec-conformant skill."',
        '    path: "atoms/skills/spec-skill"',
        '    skill_format: "agentskills"',
        "    risk_level: low",
        "",
      ].join("\n"),
    );
  });

  it("passes a conformant skill folder through byte-identical", async () => {
    const outDir = path.join(tmpRoot, "ingest-out");
    await exportPack({ source: packRoot, target: "claude-code", profile: "safe", outDir });
    const emitted = await fs.readFile(
      path.join(outDir, ".claude/skills/spec-skill/SKILL.md"),
      "utf8",
    );
    expect(emitted).toBe(specSkill);
    expect(
      await fs.readFile(
        path.join(outDir, ".claude/skills/spec-skill/scripts/run.sh"),
        "utf8",
      ),
    ).toBe("#!/bin/sh\necho ok\n");
  });

  it("validateSkillAtoms reports no issues for a conformant source", async () => {
    const loaded = await loadManifest(packRoot);
    const issues = await validateSkillAtoms(loaded.packRoot, loaded.manifest);
    expect(issues).toEqual([]);
  });

  it("a dir with both SKILL.md and skill.md emits one canonical SKILL.md", async () => {
    const dualRoot = path.join(tmpRoot, "dual-pack");
    const skillDir = path.join(dualRoot, "atoms/skills/dual");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: dual\ndescription: Canonical.\n---\n\nCanonical body.\n`,
    );
    await fs.writeFile(
      path.join(skillDir, "skill.md"),
      `---\nname: dual\ndescription: Lowercase twin.\n---\n\nTwin body.\n`,
    );
    await fs.writeFile(
      path.join(dualRoot, "AGENTPACK.yaml"),
      [
        'agentpack: "1.0"',
        "metadata:",
        '  id: "agentpack.dual"',
        '  name: "Dual"',
        '  slug: "dual"',
        '  description: "Both SKILL.md casings present."',
        '  version: "0.0.1"',
        '  publisher: "agentpack"',
        "compatibility:",
        "  targets:",
        "    claude-code: { status: supported }",
        "permissions: {}",
        "profiles:",
        "  safe:",
        '    include: ["*"]',
        "atoms:",
        '  - id: "skill:dual"',
        "    type: skill",
        '    name: "Dual"',
        '    description: "Dual-cased skill."',
        '    path: "atoms/skills/dual"',
        "    risk_level: low",
        "",
      ].join("\n"),
    );
    const outDir = path.join(tmpRoot, "dual-out");
    const result = await exportPack({
      source: dualRoot,
      target: "claude-code",
      profile: "safe",
      outDir,
    });
    // Exactly one emitted SKILL.md path (duplicate paths would roll back the
    // install at apply time), sourced from the canonical uppercase file.
    const skillPaths = result.plan.files
      .map((f) => f.path)
      .filter((p) => p.endsWith("/SKILL.md"));
    expect(skillPaths).toEqual([".claude/skills/dual/SKILL.md"]);
    const emitted = await fs.readFile(
      path.join(outDir, ".claude/skills/dual/SKILL.md"),
      "utf8",
    );
    expect(emitted).toMatch(/Canonical body\./);
  });

  it("validateSkillAtoms flags non-conformant skill sources", async () => {
    const badRoot = path.join(tmpRoot, "adversarial-pack");
    const loaded = await loadManifest(badRoot);
    const issues = await validateSkillAtoms(loaded.packRoot, loaded.manifest);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    expect(issues.map((i) => i.path).join(" ")).toMatch(/odd-name/);
  });
});
