import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  importClaudeMd,
  writeImport,
  parseClaudeMd,
  buildManifest,
  validateManifest,
  agentPackManifestSchema,
} from "../src/index.js";
import { parse as parseYaml } from "yaml";

const OPTS = { id: "acme.team", name: "Team" };

describe("parseClaudeMd", () => {
  it("strips YAML frontmatter before parsing", () => {
    const text = `---\ntitle: x\nfoo: bar\n---\n# Title\n\n## A\n\nbody a\n`;
    const parsed = parseClaudeMd(text);
    expect(parsed.title).toBe("Title");
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.heading).toBe("A");
  });

  it("treats the first # before any ## as the title, not an atom", () => {
    const text = `# My Doc\n\n## Section One\n\ncontent\n`;
    const parsed = parseClaudeMd(text);
    expect(parsed.title).toBe("My Doc");
    expect(parsed.sections.map((s) => s.heading)).toEqual(["Section One"]);
  });

  it("captures preamble text (between title and first ##) as a synthetic leading section", () => {
    const text = `# My Doc\n\nThis is the preamble.\nMore preamble.\n\n## Section One\n\ncontent\n`;
    const parsed = parseClaudeMd(text);
    expect(parsed.title).toBe("My Doc");
    // Preamble becomes a synthetic section with the title as heading, followed
    // by the real ## section — two sections total, no silent data loss.
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]!.heading).toBe("My Doc");
    expect(parsed.sections[0]!.body).toContain("This is the preamble.");
    expect(parsed.sections[0]!.body).toContain("More preamble.");
    expect(parsed.sections[1]!.heading).toBe("Section One");
  });

  it("uses 'Overview' as synthetic heading when the document has no title", () => {
    const text = `Some preamble text.\n\n## Real Section\n\ncontent\n`;
    const parsed = parseClaudeMd(text);
    expect(parsed.title).toBeNull();
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]!.heading).toBe("Overview");
    expect(parsed.sections[0]!.body).toContain("Some preamble text.");
  });

  it("does not emit a synthetic section when there is no preamble text", () => {
    // Title immediately followed by ##, with no body between them.
    const text = `# My Doc\n\n## Section One\n\ncontent\n`;
    const parsed = parseClaudeMd(text);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.heading).toBe("Section One");
  });

  it("handles a document with no title", () => {
    const text = `## Only Section\n\nbody\n`;
    const parsed = parseClaudeMd(text);
    expect(parsed.title).toBeNull();
    expect(parsed.sections).toHaveLength(1);
  });

  it("warns on @import lines and strips them from the body", () => {
    const text = `# T\n\n## Sec\n\nbefore\n@~/dev/other/CLAUDE.md\nafter\n`;
    const parsed = parseClaudeMd(text);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]!.message).toContain("@import");
    expect(parsed.sections[0]!.body).not.toContain("@~/dev/other");
    expect(parsed.sections[0]!.body).toContain("before");
    expect(parsed.sections[0]!.body).toContain("after");
  });

  it("does not treat a ## inside a fenced code block as a section boundary", () => {
    const text = [
      "# T",
      "",
      "## Real Section",
      "",
      "```md",
      "## Not A Section",
      "still fenced",
      "```",
      "",
      "tail",
    ].join("\n");
    const parsed = parseClaudeMd(text);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.heading).toBe("Real Section");
    expect(parsed.sections[0]!.body).toContain("## Not A Section");
  });

  it("respects ~~~ fences too", () => {
    const text = `# T\n\n## S\n\n~~~\n## fenced\n~~~\n`;
    const parsed = parseClaudeMd(text);
    expect(parsed.sections).toHaveLength(1);
  });

  it("preserves nested ### headings verbatim in the body", () => {
    const text = `# T\n\n## Parent\n\n### Child\n\nchild body\n`;
    const parsed = parseClaudeMd(text);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.body).toContain("### Child");
  });
});

describe("buildManifest", () => {
  it("throws when there are no sections and no preamble", () => {
    // A title with no body and no ## sections produces nothing to import.
    const parsed = parseClaudeMd("# Only A Title\n");
    expect(() => buildManifest(parsed, OPTS)).toThrow(/no .*section/i);
  });

  it("slugifies headings and de-duplicates collisions", () => {
    const text = `## My Section\n\na\n\n## My Section!\n\nb\n`;
    const parsed = parseClaudeMd(text);
    const { manifest } = buildManifest(parsed, OPTS);
    const ids = manifest.atoms.map((a) => a.id);
    expect(ids).toContain("instruction:my-section");
    expect(ids).toContain("instruction:my-section-2");
  });

  it("marks plain CLAUDE.md imports as native only to Claude Code", () => {
    const parsed = parseClaudeMd("## Working Style\n\nbody\n");
    const { manifest } = buildManifest(parsed, OPTS);
    expect(manifest.compatibility.targets["claude-code"]?.status).toBe("supported");
    expect(manifest.compatibility.targets.codex?.status).toBe("partial");
  });

  it("promotes governance/security headings to rules", () => {
    for (const h of [
      "Security",
      "Auth at the boundary",
      "Git",
      "Verification",
      "Definition of done",
    ]) {
      const parsed = parseClaudeMd(`## ${h}\n\n- do a thing\n`);
      const { manifest } = buildManifest(parsed, OPTS);
      expect(manifest.atoms[0]!.type).toBe("rule");
    }
  });

  it("leaves non-governance headings as instructions", () => {
    const parsed = parseClaudeMd("## Working Style\n\nbody\n");
    const { manifest } = buildManifest(parsed, OPTS);
    expect(manifest.atoms[0]!.type).toBe("instruction");
  });

  it("splits rule bullets into must / must_not by prefix", () => {
    const text = [
      "## Git",
      "",
      "- Commit when asked.",
      "- Never force-push.",
      "- Don't amend published commits.",
      "- Do not stage secrets.",
    ].join("\n");
    const parsed = parseClaudeMd(text);
    const { files } = buildManifest(parsed, OPTS);
    const ruleFile = files.find((f) => f.relativePath.endsWith(".yaml"))!;
    const rule = parseYaml(ruleFile.content) as {
      behavior: { must: string[]; must_not: string[] };
    };
    expect(rule.behavior.must).toEqual(["Commit when asked."]);
    expect(rule.behavior.must_not).toEqual([
      "force-push.",
      "amend published commits.",
      "stage secrets.",
    ]);
  });

  it("falls back to a single must prose entry when a rule has no bullets", () => {
    const parsed = parseClaudeMd("## Security\n\nAlways review auth code carefully.\n");
    const { files } = buildManifest(parsed, OPTS);
    const rule = parseYaml(files[0]!.content) as {
      behavior: { must: string[]; must_not: string[] };
    };
    expect(rule.behavior.must).toHaveLength(1);
    expect(rule.behavior.must[0]).toContain("review auth code");
    expect(rule.behavior.must_not).toEqual([]);
  });

  it("folds wrapped continuation lines into a single bullet", () => {
    const text = [
      "## Git",
      "",
      "- Stage specific files — avoid `git add -A`",
      "  so secrets do not slip in.",
    ].join("\n");
    const parsed = parseClaudeMd(text);
    const { files } = buildManifest(parsed, OPTS);
    const rule = parseYaml(files[0]!.content) as {
      behavior: { must: string[] };
    };
    expect(rule.behavior.must[0]).toContain("so secrets do not slip in");
  });

  it("parses ordered-list (1./2)/...) items as individual must/must_not entries", () => {
    const text = [
      "## Auth at the boundary",
      "",
      "1. Auth-by-default, not auth-by-config.",
      "2. Refuse to start if the auth secret is unset or too short.",
      "3. Opt-out is explicit, named, and greppable.",
      "4. Never trust upstream layers — each layer rejects on its own.",
      "5. Failure mode is closed.",
      "6. Local dev uses a real token through the same verifier.",
    ].join("\n");
    const parsed = parseClaudeMd(text);
    const { files } = buildManifest(parsed, OPTS);
    const rule = parseYaml(files[0]!.content) as {
      behavior: { must: string[]; must_not: string[] };
    };
    // Six distinct items, not one flattened/truncated prose blob.
    expect(rule.behavior.must).toHaveLength(5);
    expect(rule.behavior.must_not).toEqual([
      "trust upstream layers — each layer rejects on its own.",
    ]);
    expect(rule.behavior.must[0]).toBe("Auth-by-default, not auth-by-config.");
    expect(rule.behavior.must[4]).toContain("Local dev uses a real token");
  });

  it("folds wrapped continuation lines into an ordered-list item", () => {
    const text = [
      "## Git",
      "",
      "1. Stage specific files — avoid `git add -A`",
      "   so secrets do not slip in.",
    ].join("\n");
    const parsed = parseClaudeMd(text);
    const { files } = buildManifest(parsed, OPTS);
    const rule = parseYaml(files[0]!.content) as { behavior: { must: string[] } };
    expect(rule.behavior.must).toHaveLength(1);
    expect(rule.behavior.must[0]).toContain("so secrets do not slip in");
  });

  it("coerces a blank --name to a non-empty metadata.name (never writes invalid)", () => {
    const parsed = parseClaudeMd("# Doc Title\n\n## A\n\nbody\n");
    const { manifest } = buildManifest(parsed, { id: "acme.team", name: "   " });
    expect(manifest.metadata.name.length).toBeGreaterThan(0);
    expect(manifest.metadata.name).toBe("Doc Title");
    expect(validateManifest(manifest).valid).toBe(true);
  });

  it("falls back to the slug when both --name and title are blank", () => {
    const parsed = parseClaudeMd("## A\n\nbody\n");
    const { manifest } = buildManifest(parsed, { id: "acme.team-defaults", name: "" });
    expect(manifest.metadata.name).toBe("team-defaults");
    expect(validateManifest(manifest).valid).toBe(true);
  });
});

describe("importClaudeMd", () => {
  it("produces a schema-valid, semantically-valid manifest", () => {
    const text = [
      "# How We Work",
      "",
      "## Working Style",
      "",
      "Plan before non-trivial work.",
      "",
      "## Git",
      "",
      "- Never force-push.",
    ].join("\n");
    const result = importClaudeMd(text, OPTS);
    const manifestFile = result.files.find((f) => f.relativePath === "AGENTPACK.yaml")!;
    const parsedManifest = parseYaml(manifestFile.content);
    // Schema (zod) accepts it.
    expect(() => agentPackManifestSchema.parse(parsedManifest)).not.toThrow();
    // Semantic validator accepts it (atom-id prefix, profiles, etc.).
    const validation = validateManifest(parsedManifest);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('emits `agentpack: "1.0"` as a quoted string (not a float)', () => {
    const result = importClaudeMd("## A\n\nbody\n", OPTS);
    const manifestFile = result.files.find((f) => f.relativePath === "AGENTPACK.yaml")!;
    expect(manifestFile.content).toContain('agentpack: "1.0"');
    const parsed = parseYaml(manifestFile.content) as { agentpack: unknown };
    expect(parsed.agentpack).toBe("1.0");
    expect(typeof parsed.agentpack).toBe("string");
  });

  it("uses every atom id prefixed by its type", () => {
    const result = importClaudeMd("## Working Style\n\nx\n\n## Git\n\n- never x\n", OPTS);
    for (const atom of result.manifest.atoms) {
      expect(atom.id.startsWith(`${atom.type}:`)).toBe(true);
    }
  });

  it("gives every atom and the manifest a non-empty description", () => {
    const result = importClaudeMd("## A\n\nbody\n", OPTS);
    expect(result.manifest.metadata.description.length).toBeGreaterThan(0);
    for (const atom of result.manifest.atoms) {
      expect(atom.description.length).toBeGreaterThan(0);
    }
  });

  it("yields a valid manifest even when name is empty (coerced, not invalid)", () => {
    const result = importClaudeMd("# T\n\n## A\n\nbody\n", { id: "acme.team", name: "" });
    expect(result.manifest.metadata.name.length).toBeGreaterThan(0);
    const manifestFile = result.files.find((f) => f.relativePath === "AGENTPACK.yaml")!;
    const validation = validateManifest(parseYaml(manifestFile.content));
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });
});

describe("writeImport — path-traversal defense", () => {
  it("rejects a `..` traversal relativePath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-write-"));
    try {
      await expect(
        writeImport(
          {
            manifest: {} as never,
            files: [{ relativePath: "../evil", content: "x" }],
            warnings: [],
          },
          dir,
        ),
      ).rejects.toThrow(/outside the output directory/);
      await expect(fs.access(path.join(path.dirname(dir), "evil"))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an absolute relativePath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-write-"));
    try {
      await expect(
        writeImport(
          {
            manifest: {} as never,
            files: [{ relativePath: path.join(os.tmpdir(), "abs-evil"), content: "x" }],
            warnings: [],
          },
          dir,
        ),
      ).rejects.toThrow(/outside the output directory/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a leading-separator relativePath", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-write-"));
    try {
      await expect(
        writeImport(
          {
            manifest: {} as never,
            files: [{ relativePath: "/etc/evil", content: "x" }],
            warnings: [],
          },
          dir,
        ),
      ).rejects.toThrow(/outside the output directory/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
