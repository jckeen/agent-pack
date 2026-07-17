// Issue #133: target-specific atom variants — schema acceptance criteria.
//
//  - One atom can declare per-target source/body variants (`variants` map keyed
//    by TargetPlatform, each entry exactly one of `path` | `body`).
//  - `path` becomes optional only when `variants` is present; existing
//    manifests (no variants) must parse byte-identically — pinned below.
//  - Variant paths obey the same trust rules as `atom.path` (no absolute
//    paths, no `..`, no `~`).

import { describe, expect, it } from "vitest";
import { agentPackManifestSchema, validateManifest } from "../src/index.js";

function baseManifest(atomOverrides: Record<string, unknown>): Record<string, unknown> {
  return {
    agentpack: "1.0",
    metadata: {
      id: "agentpack.variants-schema",
      name: "Variants Schema Fixture",
      slug: "variants-schema",
      description: "In-memory manifest for variant schema tests.",
      version: "0.1.0",
      publisher: "agentpack",
    },
    compatibility: { targets: { generic: { status: "supported" } } },
    profiles: { full: { include: ["*"] } },
    atoms: [
      {
        id: "instruction:house-style",
        type: "instruction",
        name: "House Style",
        description: "A plain instruction atom.",
        risk_level: "low",
        ...atomOverrides,
      },
    ],
  };
}

describe("atom `variants` schema (#133 AC1)", () => {
  it("accepts per-target variants with a path or an inline body", () => {
    const manifest = baseManifest({
      path: "atoms/instructions/house-style.md",
      variants: {
        "claude-code": { path: "atoms/instructions/house-style.claude-code.md" },
        codex: { path: "atoms/instructions/house-style.codex.md" },
        generic: { body: "Inline generic body." },
      },
    });
    const parsed = agentPackManifestSchema.parse(manifest);
    const atom = parsed.atoms[0]!;
    expect(atom.variants).toMatchObject({
      "claude-code": { path: "atoms/instructions/house-style.claude-code.md" },
      generic: { body: "Inline generic body." },
    });
    expect(validateManifest(manifest).valid).toBe(true);
  });

  it("allows omitting the default `path` when variants are declared", () => {
    const manifest = baseManifest({
      variants: { codex: { path: "atoms/instructions/house-style.codex.md" } },
    });
    expect(validateManifest(manifest).valid).toBe(true);
  });

  it("rejects an atom with neither path, body, nor variants", () => {
    const manifest = baseManifest({});
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path.includes("atoms"))).toBe(true);
  });

  it("rejects a variant that sets both `path` and `body`", () => {
    const manifest = baseManifest({
      path: "atoms/instructions/house-style.md",
      variants: {
        codex: { path: "atoms/instructions/x.md", body: "also inline" },
      },
    });
    expect(validateManifest(manifest).valid).toBe(false);
  });

  it("rejects a variant that sets neither `path` nor `body`", () => {
    const manifest = baseManifest({
      path: "atoms/instructions/house-style.md",
      variants: { codex: {} },
    });
    expect(validateManifest(manifest).valid).toBe(false);
  });

  it("rejects an atom that sets both a default `path` and a default `body`", () => {
    const manifest = baseManifest({
      path: "atoms/instructions/house-style.md",
      body: "also inline",
    });
    expect(validateManifest(manifest).valid).toBe(false);
  });

  it("applies atom.path trust rules to variant paths (traversal, absolute, ~)", () => {
    for (const bad of ["../outside.md", "/etc/passwd", "~/secrets.md"]) {
      const manifest = baseManifest({
        path: "atoms/instructions/house-style.md",
        variants: { codex: { path: bad } },
      });
      expect(validateManifest(manifest).valid, `variant path ${bad}`).toBe(false);
    }
  });

  it("rejects unknown target keys in the variants map", () => {
    const manifest = baseManifest({
      path: "atoms/instructions/house-style.md",
      variants: { "not-a-target": { body: "x" } },
    });
    expect(validateManifest(manifest).valid).toBe(false);
  });

  it("warns when a variant path duplicates the atom's default path (no-op variant)", () => {
    const manifest = baseManifest({
      path: "atoms/instructions/house-style.md",
      variants: { codex: { path: "atoms/instructions/house-style.md" } },
    });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "atom.variant_duplicates_default")).toBe(
      true,
    );
  });

  it("warns when a variant-only atom leaves a declared compatibility target uncovered", () => {
    const manifest = baseManifest({
      variants: { codex: { path: "atoms/instructions/house-style.codex.md" } },
    });
    // Pack declares `generic` supported, but the only atom has no generic
    // variant and no default body — installs there will drop it.
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.code === "atom.variant_target_gap")).toBe(true);
  });
});

describe("backward compatibility pin (#133): variant-free manifests are unchanged", () => {
  it("parses a pre-variants manifest to exactly the input shape (no injected fields)", () => {
    const manifest = baseManifest({ path: "atoms/instructions/house-style.md" });
    const parsed = agentPackManifestSchema.parse(manifest);
    // Byte-identical semantics: nothing added, nothing removed, no defaults
    // materialized on atoms that never declared variants.
    expect(parsed).toEqual(manifest);
    expect(Object.keys(parsed.atoms[0]!)).not.toContain("variants");
    expect(Object.keys(parsed.atoms[0]!)).not.toContain("body");
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
