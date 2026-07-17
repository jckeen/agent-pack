// Issue #133: target-specific atom variants — planner + adapter acceptance
// criteria, exercised against the shared `variants-pack` fixture:
//
//  - Profile resolution keeps ONE stable atom id while selecting the target
//    variant: planning the same pack for two targets yields identical atom
//    identity in the plan, different compiled content (AC2, AC5).
//  - A target with no matching variant and no default body surfaces through
//    the #154 channel — `unsupportedAtoms` + a structured warning +
//    `observedFidelity: "partial"` — never a silent drop (AC3).
//  - Variant resolution happens BEFORE the adapter boundary: adapters receive
//    ordinary atoms and never see the `variants` map.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  claudeCodeAdapter,
  codexAdapter,
  createInstallPlan,
  genericAdapter,
  loadManifest,
  selectAtomVariants,
  resolveAtoms,
  type InstallPlan,
} from "../src/index.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "variants-pack",
);

async function planFor(target: "claude-code" | "codex" | "generic"): Promise<InstallPlan> {
  const { manifest, packRoot } = await loadManifest(FIXTURE);
  const adapter =
    target === "claude-code"
      ? claudeCodeAdapter
      : target === "codex"
        ? codexAdapter
        : genericAdapter;
  return createInstallPlan({ manifest, packRoot, target, profile: "full", adapter });
}

function fileContent(plan: InstallPlan, filePath: string): string {
  const file = plan.files.find((f) => f.path === filePath);
  expect(file, `expected plan to emit ${filePath}`).toBeDefined();
  return file!.content;
}

describe("shared atom identity across targets (#133 AC2, AC5)", () => {
  it("keeps one stable atom id while each target compiles its own body", async () => {
    const claude = await planFor("claude-code");
    const codex = await planFor("codex");
    const generic = await planFor("generic");

    // Identity: the same atom ids appear in every plan, regardless of target.
    expect(claude.atoms).toContain("instruction:release-workflow");
    expect(codex.atoms).toEqual(claude.atoms);
    expect(generic.atoms).toEqual(claude.atoms);
    expect(codex.atomTypes).toEqual(claude.atomTypes);

    // Content: each target compiled ITS variant of the shared atom.
    const claudeMd = fileContent(claude, "CLAUDE.md");
    expect(claudeMd).toContain("CLAUDE-BODY");
    expect(claudeMd).not.toContain("CODEX-BODY");
    expect(claudeMd).not.toContain("DEFAULT-BODY");

    const codexAgents = fileContent(codex, "AGENTS.md");
    expect(codexAgents).toContain("CODEX-BODY");
    expect(codexAgents).not.toContain("CLAUDE-BODY");
    expect(codexAgents).not.toContain("DEFAULT-BODY");

    // The generic variant is an inline `body` — no file behind it.
    const genericAgents = fileContent(generic, "AGENTS.md");
    expect(genericAgents).toContain("GENERIC-BODY");
    expect(genericAgents).not.toContain("CLAUDE-BODY");
    expect(genericAgents).not.toContain("DEFAULT-BODY");
  });

  it("falls back to the default body when a target has no variant, without downgrading", async () => {
    const { manifest, packRoot } = await loadManifest(FIXTURE);
    // Drop the variant-only atom so only the default-carrying atom remains.
    manifest.atoms = manifest.atoms.filter((a) => a.id === "instruction:release-workflow");
    // `cursor` has no variant on the shared atom → default body, full fidelity.
    const plan = await createInstallPlan({
      manifest,
      packRoot,
      target: "cursor",
      profile: "full",
      adapter: {
        target: "cursor",
        export: async (opts) => {
          // Variant resolution happened before the adapter boundary: the atom
          // arrives with its default path and no `variants` map.
          const atom = opts.resolvedAtoms[0]!.atom;
          expect(atom.path).toBe("atoms/instructions/release-workflow.md");
          expect("variants" in atom).toBe(false);
          return { target: "cursor", files: [], warnings: [], unsupportedAtoms: [] };
        },
      },
    });
    expect(plan.unsupportedAtoms).toEqual([]);
    expect(plan.observedFidelity).toBe("supported");
  });
});

describe("missing variant downgrades observed fidelity (#133 AC3)", () => {
  it("reports a variant-only atom with no matching variant as unsupported, not silently dropped", async () => {
    const codex = await planFor("codex");
    expect(codex.unsupportedAtoms).toContain("instruction:claude-only-notes");
    expect(codex.observedFidelity).toBe("partial");
    expect(
      codex.warnings.some(
        (w) => w.includes("instruction:claude-only-notes") && w.includes("codex"),
      ),
    ).toBe(true);
    // Identity is preserved even for the uncompilable atom (AC2).
    expect(codex.atoms).toContain("instruction:claude-only-notes");
    // No content leaked from another target's variant.
    expect(fileContent(codex, "AGENTS.md")).not.toContain("CLAUDE-ONLY-BODY");
  });

  it("compiles the claude-only atom on its own target with full fidelity", async () => {
    const claude = await planFor("claude-code");
    expect(claude.unsupportedAtoms).not.toContain("instruction:claude-only-notes");
    expect(fileContent(claude, "CLAUDE.md")).toContain("CLAUDE-ONLY-BODY");
    expect(claude.observedFidelity).toBe("supported");
  });
});

describe("lockfile identity across targets (#133 AC2)", () => {
  it("records the same atom ids in the lockfile for claude-code and codex installs", async () => {
    const { planInstall } = await import("../src/install/index.js");
    const generator = { cli: "0.0.0-test", adapter: "0.0.0-test" };
    const dirs = await Promise.all([
      fs.mkdtemp(path.join(os.tmpdir(), "agentpack-variants-claude-")),
      fs.mkdtemp(path.join(os.tmpdir(), "agentpack-variants-codex-")),
    ]);
    try {
      const [claudePlan, codexPlan] = await Promise.all([
        planInstall({
          source: FIXTURE,
          target: "claude-code",
          profile: "full",
          projectRoot: dirs[0]!,
          generator,
        }),
        planInstall({
          source: FIXTURE,
          target: "codex",
          profile: "full",
          projectRoot: dirs[1]!,
          generator,
        }),
      ]);
      const ids = (lock: { atoms: Array<{ id: string }> }) =>
        lock.atoms.map((a) => a.id).sort();
      expect(ids(codexPlan.lockfile)).toEqual(ids(claudePlan.lockfile));
      // Different compiled content behind the shared identity.
      expect(claudePlan.lockfile).not.toEqual(codexPlan.lockfile);
    } finally {
      await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });
});

describe("selectAtomVariants unit behavior (#133)", () => {
  it("passes variant-free atoms through unchanged (same object identity)", async () => {
    const { manifest } = await loadManifest(FIXTURE);
    manifest.atoms = [
      {
        id: "instruction:plain",
        type: "instruction",
        name: "Plain",
        description: "No variants.",
        path: "atoms/instructions/plain.md",
        risk_level: "low",
      },
    ];
    const resolved = resolveAtoms({ manifest, profile: "full" });
    const selection = selectAtomVariants(resolved, "codex");
    expect(selection.atoms[0]!.atom).toBe(resolved[0]!.atom);
    expect(selection.unsupportedAtoms).toEqual([]);
    expect(selection.warnings).toEqual([]);
  });

  it("strips the variants map from atoms handed to adapters", async () => {
    const { manifest } = await loadManifest(FIXTURE);
    const resolved = resolveAtoms({ manifest, profile: "full" });
    const selection = selectAtomVariants(resolved, "claude-code");
    for (const r of selection.atoms) {
      expect("variants" in r.atom).toBe(false);
    }
  });
});
