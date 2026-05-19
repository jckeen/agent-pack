import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifest, validateManifest } from "../src/index.js";

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");

describe("manifest parsing & validation", () => {
  it("loads and validates the bundled PR-Quality example pack", async () => {
    const loaded = await loadManifest(EXAMPLE);
    const result = validateManifest(loaded.manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects manifests with duplicate atom ids", () => {
    const manifest = baseManifest();
    manifest.atoms.push({ ...manifest.atoms[0]! });
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "atom.duplicate_id")).toBe(true);
  });

  it("rejects manifests with profile include patterns that match no atom", () => {
    const manifest = baseManifest();
    manifest.profiles.safe = {
      description: "broken",
      include: ["instruction:does-not-exist"],
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "profile.unresolved_include"),
    ).toBe(true);
  });

  it("rejects manifests with no profiles", () => {
    const manifest = baseManifest();
    manifest.profiles = {};
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "profiles" || e.code.startsWith("schema."))).toBe(true);
  });

  it("rejects manifests with an atom id whose prefix differs from declared type", () => {
    const manifest = baseManifest();
    manifest.atoms[0]!.id = "rule:wrong-prefix";
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.code === "atom.id_type_mismatch"),
    ).toBe(true);
  });

  it("rejects manifests whose `agentpack` version is not 1.x", () => {
    const manifest = baseManifest();
    manifest.agentpack = "2.0";
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
  });

  it("rejects atoms with unknown type", () => {
    const manifest = baseManifest();
    manifest.atoms[0]!.type = "ghost" as never;
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
  });

  it("rejects atom paths whose basename is a Windows reserved name", () => {
    // Cross-platform pack distribution: a pack that ships with CON.md or
    // LPT1.md fails kernel-level writes on Windows regardless of the
    // application. Surface as a validate error rather than a download-time
    // surprise. From qa-lead iter-5 LOW-7.
    for (const reserved of ["CON.md", "PRN.txt", "AUX/file.md", "NUL", "COM1.json", "lpt9.md", "Con.md"]) {
      const manifest = baseManifest();
      manifest.atoms[0]!.path = reserved;
      const result = validateManifest(manifest);
      expect(
        result.errors.some((e) => /windows-reserved name/i.test(e.message ?? "")),
        `expected windows-reserved rejection for "${reserved}"`,
      ).toBe(true);
    }
  });
});

function baseManifest() {
  return {
    agentpack: "1.0",
    metadata: {
      id: "test.example",
      name: "Test",
      slug: "example",
      description: "test pack",
      version: "0.0.1",
      publisher: "test",
    },
    compatibility: {
      targets: {
        "claude-code": { status: "supported" as const },
      },
    },
    profiles: {
      safe: {
        description: "safe",
        include: ["instruction:project-defaults"],
      },
    },
    atoms: [
      {
        id: "instruction:project-defaults",
        type: "instruction" as const,
        name: "Defaults",
        description: "Defaults.",
        path: "atoms/instructions/project-defaults.md",
        risk_level: "low" as const,
      },
    ],
  };
}
