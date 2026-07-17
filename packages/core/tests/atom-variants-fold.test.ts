// Issue #133 AC4: `import --into` (fold, sync S3 #112) must preserve another
// runtime's atom variant instead of overwriting it. Exact scenario under test:
// a pack whose atom carries a `codex` variant is re-folded from Claude-sourced
// content — the codex variant (manifest entry AND its file) survives, while
// the claude-code variant is superseded by the fresh Claude content.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  foldImportInto,
  importClaudeMd,
  type AgentPackManifest,
  type Atom,
} from "../src/index.js";

const CODEX_VARIANT_PATH = "atoms/instructions/release-workflow.codex.md";
const CLAUDE_VARIANT_PATH = "atoms/instructions/release-workflow.claude-code.md";

/** Build an on-disk pack whose shared atom carries codex + claude-code variants. */
async function makeExistingPack(): Promise<{
  packDir: string;
  existing: AgentPackManifest;
}> {
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-fold-variants-"));
  const existing: AgentPackManifest = {
    agentpack: "1.0",
    metadata: {
      id: "agentpack.fold-variants",
      name: "Fold Variants",
      slug: "fold-variants",
      description: "Pack with per-target variants, target of an import fold.",
      version: "0.1.0",
      publisher: "agentpack",
    },
    compatibility: {
      targets: { "claude-code": { status: "supported" }, codex: { status: "supported" } },
    },
    profiles: { all: { description: "All imported atoms.", include: ["*"] } },
    atoms: [
      {
        id: "instruction:release-workflow",
        type: "instruction",
        name: "Release Workflow",
        description: "Shared workflow with per-target variants.",
        path: "atoms/instructions/release-workflow.md",
        risk_level: "low",
        permissions: [],
        variants: {
          codex: { path: CODEX_VARIANT_PATH },
          "claude-code": { path: CLAUDE_VARIANT_PATH },
        },
      },
    ],
    exports: { default_profile: "all" },
  };
  await fs.mkdir(path.join(packDir, "atoms/instructions"), { recursive: true });
  await fs.writeFile(
    path.join(packDir, "AGENTPACK.yaml"),
    stringifyYaml(existing, { lineWidth: 0 }),
  );
  await fs.writeFile(
    path.join(packDir, "atoms/instructions/release-workflow.md"),
    "OLD-DEFAULT-BODY\n",
  );
  await fs.writeFile(path.join(packDir, CODEX_VARIANT_PATH), "CODEX-VARIANT-BODY\n");
  await fs.writeFile(path.join(packDir, CLAUDE_VARIANT_PATH), "OLD-CLAUDE-VARIANT-BODY\n");
  return { packDir, existing };
}

const CLAUDE_MD =
  "# Fold Variants\n\n## Release Workflow\n\nFRESH-CLAUDE-BODY: the live claude workflow.\n";

function foldedAtom(changes: Array<{ path: string; after?: string }>): Atom {
  const manifestChange = changes.find((c) => c.path === "AGENTPACK.yaml");
  expect(manifestChange, "fold should rewrite AGENTPACK.yaml").toBeDefined();
  const merged = parseYaml(manifestChange!.after!) as AgentPackManifest;
  const atom = merged.atoms.find((a) => a.id === "instruction:release-workflow");
  expect(atom, "shared atom must survive the fold").toBeDefined();
  return atom!;
}

describe("fold preserves another runtime's variant (#133 AC4)", () => {
  it("keeps the codex variant when folding Claude-sourced content", async () => {
    const { packDir, existing } = await makeExistingPack();
    try {
      const result = importClaudeMd(CLAUDE_MD, {
        id: existing.metadata.id,
        source: "claude-code",
      });
      const { changes } = await foldImportInto({
        result,
        existing,
        packDir,
        apply: false,
        sourceTarget: "claude-code",
      });

      const atom = foldedAtom(changes);
      // The codex variant survives the fold verbatim.
      expect(atom.variants?.codex).toEqual({ path: CODEX_VARIANT_PATH });
      // The codex variant FILE is not treated as stale.
      expect(changes.find((c) => c.path === CODEX_VARIANT_PATH)).toBeUndefined();
      // The fold's source target owns its content now: the stale claude-code
      // variant is dropped (its file removed) in favor of the fresh default body.
      expect(atom.variants?.["claude-code"]).toBeUndefined();
      expect(changes.find((c) => c.path === CLAUDE_VARIANT_PATH)?.kind).toBe("removed");
    } finally {
      await fs.rm(packDir, { recursive: true, force: true });
    }
  });

  it("applies the fold on disk without deleting the codex variant file", async () => {
    const { packDir, existing } = await makeExistingPack();
    try {
      const result = importClaudeMd(CLAUDE_MD, {
        id: existing.metadata.id,
        source: "claude-code",
      });
      const { removalFailures } = await foldImportInto({
        result,
        existing,
        packDir,
        apply: true,
        sourceTarget: "claude-code",
      });
      expect(removalFailures).toEqual([]);

      const codexBody = await fs.readFile(path.join(packDir, CODEX_VARIANT_PATH), "utf8");
      expect(codexBody).toBe("CODEX-VARIANT-BODY\n");
      const mergedYaml = await fs.readFile(path.join(packDir, "AGENTPACK.yaml"), "utf8");
      const merged = parseYaml(mergedYaml) as AgentPackManifest;
      const atom = merged.atoms.find((a) => a.id === "instruction:release-workflow")!;
      expect(atom.variants?.codex).toEqual({ path: CODEX_VARIANT_PATH });
      // Fresh Claude content landed as the atom's default body.
      const defaultBody = await fs.readFile(
        path.join(packDir, "atoms/instructions/release-workflow.md"),
        "utf8",
      );
      expect(defaultBody).toContain("FRESH-CLAUDE-BODY");
      // The superseded claude-code variant file is gone.
      await expect(fs.stat(path.join(packDir, CLAUDE_VARIANT_PATH))).rejects.toThrow();
    } finally {
      await fs.rm(packDir, { recursive: true, force: true });
    }
  });

  it("preserves all variants when the fold has no declared source target", async () => {
    const { packDir, existing } = await makeExistingPack();
    try {
      const result = importClaudeMd(CLAUDE_MD, {
        id: existing.metadata.id,
        source: "generic",
      });
      const { changes } = await foldImportInto({
        result,
        existing,
        packDir,
        apply: false,
      });
      const atom = foldedAtom(changes);
      expect(atom.variants?.codex).toEqual({ path: CODEX_VARIANT_PATH });
      expect(atom.variants?.["claude-code"]).toEqual({ path: CLAUDE_VARIANT_PATH });
      expect(changes.find((c) => c.path === CODEX_VARIANT_PATH)).toBeUndefined();
      expect(changes.find((c) => c.path === CLAUDE_VARIANT_PATH)).toBeUndefined();
    } finally {
      await fs.rm(packDir, { recursive: true, force: true });
    }
  });
});
