// Issue #134: enforce and derive target compatibility during install planning.
//
// The planner must consume the authored `manifest.compatibility.targets[target]`
// declaration:
//   - `unsupported` → refuse with a structured error BEFORE the adapter runs
//     (no write plan is ever produced);
//   - `partial` / `experimental` → surface a structured warning so the CLI can
//     require explicit acknowledgement;
//   - derive compiler-observed fidelity from adapter warnings + unsupported
//     atoms, reported SEPARATELY from the authored claim;
//   - invariant: adapter-observed unsupported atoms can never coexist with a
//     derived `supported` fidelity.

import { describe, expect, it } from "vitest";
import {
  createInstallPlan,
  UnsupportedTargetError,
  type AgentPackAdapter,
  type AgentPackManifest,
  type CompatibilityMap,
  type TargetPlatform,
} from "../src/index.js";

function makeManifest(overrides?: {
  targets?: CompatibilityMap;
  riskSummary?: string;
}): AgentPackManifest {
  return {
    agentpack: "1.0",
    metadata: {
      id: "agentpack.compat-fixture",
      name: "Compat Fixture",
      slug: "compat-fixture",
      description: "In-memory pack for target-compatibility planner tests.",
      version: "0.1.0",
      publisher: "agentpack",
    },
    compatibility: {
      targets: overrides?.targets ?? { generic: { status: "supported" } },
    },
    ...(overrides?.riskSummary
      ? {
          security: {
            risk_level: "low" as const,
            risk_summary: overrides.riskSummary,
          },
        }
      : {}),
    profiles: {
      full: { description: "everything", include: ["*"] },
    },
    atoms: [
      {
        id: "instruction:house-style",
        type: "instruction",
        name: "House Style",
        description: "A plain instruction atom.",
        path: "atoms/instructions/house-style.md",
        risk_level: "low",
      },
    ],
  };
}

/** Stub adapter with configurable warnings/unsupported atoms; records calls. */
function makeAdapter(config?: {
  target?: TargetPlatform;
  warnings?: string[];
  unsupportedAtoms?: string[];
}): { adapter: AgentPackAdapter; exportCalls: () => number } {
  let calls = 0;
  const target = config?.target ?? "generic";
  const adapter: AgentPackAdapter = {
    target,
    export: async () => {
      calls += 1;
      return {
        target,
        files: [{ path: "AGENTS.md", content: "# hi\n", action: "create" as const }],
        warnings: config?.warnings ?? [],
        unsupportedAtoms: config?.unsupportedAtoms ?? [],
      };
    },
  };
  return { adapter, exportCalls: () => calls };
}

async function plan(
  manifest: AgentPackManifest,
  adapterConfig?: Parameters<typeof makeAdapter>[0],
  target: TargetPlatform = "generic",
) {
  const { adapter, exportCalls } = makeAdapter(adapterConfig);
  const result = await createInstallPlan({
    manifest,
    packRoot: "/nonexistent-pack-root",
    target,
    profile: "full",
    adapter,
  });
  return { result, exportCalls };
}

describe("authored `unsupported` target refusal (AC1)", () => {
  it("throws a structured UnsupportedTargetError and never runs the adapter", async () => {
    const manifest = makeManifest({
      targets: { generic: { status: "unsupported", notes: "no generic story yet" } },
    });
    const { adapter, exportCalls } = makeAdapter();
    await expect(
      createInstallPlan({
        manifest,
        packRoot: "/nonexistent-pack-root",
        target: "generic",
        profile: "full",
        adapter,
      }),
    ).rejects.toThrow(UnsupportedTargetError);
    // No write plan was produced: the adapter (the only file-plan producer)
    // was never invoked.
    expect(exportCalls()).toBe(0);
  });

  it("carries the target, pack id, and authored notes on the error", async () => {
    const manifest = makeManifest({
      targets: { codex: { status: "unsupported", notes: "hooks cannot map" } },
    });
    const { adapter } = makeAdapter({ target: "codex" });
    const err = await createInstallPlan({
      manifest,
      packRoot: "/nonexistent-pack-root",
      target: "codex",
      profile: "full",
      adapter,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnsupportedTargetError);
    const typed = err as UnsupportedTargetError;
    expect(typed.name).toBe("UnsupportedTargetError");
    expect(typed.target).toBe("codex");
    expect(typed.packId).toBe("agentpack.compat-fixture");
    expect(typed.message).toContain("codex");
    expect(typed.message).toContain("hooks cannot map");
  });
});

describe("partial/experimental warnings + authored claim (AC2, AC5)", () => {
  it("emits a structured warning for a PARTIAL target and reports the authored claim", async () => {
    const manifest = makeManifest({
      targets: { generic: { status: "partial", notes: "hooks are dropped" } },
    });
    const { result } = await plan(manifest);
    expect(result.authoredCompatibility).toBe("partial");
    const compatWarning = result.warnings.find(
      (w) => w.includes("partial") && w.includes("generic"),
    );
    expect(compatWarning).toBeDefined();
    expect(compatWarning).toContain("hooks are dropped");
  });

  it("emits a structured warning for an EXPERIMENTAL target", async () => {
    const manifest = makeManifest({
      targets: { generic: { status: "experimental" } },
    });
    const { result } = await plan(manifest);
    expect(result.authoredCompatibility).toBe("experimental");
    expect(
      result.warnings.some((w) => w.includes("experimental") && w.includes("generic")),
    ).toBe(true);
  });

  it("reports authored claim and observed fidelity as two distinct fields", async () => {
    // Authored says supported; the compiler observes adapter warnings. The
    // authored claim must NOT be rewritten by observation — both surfaces
    // report independently.
    const manifest = makeManifest({
      targets: { generic: { status: "supported" } },
    });
    const { result } = await plan(manifest, {
      warnings: ["skill `x` emitted without frontmatter"],
    });
    expect(result.authoredCompatibility).toBe("supported");
    expect(result.observedFidelity).toBe("partial");
  });
});

describe("observed fidelity derivation (AC3)", () => {
  it("derives `supported` when the adapter reports zero warnings and zero unsupported atoms", async () => {
    const { result } = await plan(makeManifest());
    expect(result.observedFidelity).toBe("supported");
  });

  it("derives `partial` when the adapter reports warnings", async () => {
    const { result } = await plan(makeManifest(), {
      warnings: ["command `y` degraded to instruction"],
    });
    expect(result.observedFidelity).toBe("partial");
  });

  it("derives from ADAPTER warnings only — declared risk summaries and secret notes do not downgrade fidelity", async () => {
    const manifest = makeManifest({ riskSummary: "Low — instruction content only." });
    const { result } = await plan(manifest);
    // The plan-level warning list is non-empty (risk summary), but none of it
    // is adapter-observed.
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.observedFidelity).toBe("supported");
  });
});

describe("unsupported atoms force a downgrade (AC4)", () => {
  it("never derives `supported` when the adapter reports unsupported atoms", async () => {
    const { result } = await plan(makeManifest(), {
      unsupportedAtoms: ["hook:pre-commit"],
    });
    expect(result.unsupportedAtoms).toEqual(["hook:pre-commit"]);
    expect(result.observedFidelity).not.toBe("supported");
    expect(result.observedFidelity).toBe("partial");
  });

  it("holds the invariant even when the authored claim says supported", async () => {
    const manifest = makeManifest({
      targets: { generic: { status: "supported" } },
    });
    const { result } = await plan(manifest, { unsupportedAtoms: ["hook:pre-commit"] });
    // Authored claim survives as authored; the observed result downgrades.
    expect(result.authoredCompatibility).toBe("supported");
    expect(result.observedFidelity).toBe("partial");
  });
});

describe("undeclared targets keep working exactly as today (backward compat)", () => {
  it("plans without friction when the manifest declares nothing for the install target", async () => {
    // Declares codex only; installs to generic.
    const manifest = makeManifest({
      targets: { codex: { status: "supported" } },
    });
    const { result, exportCalls } = await plan(manifest);
    expect(exportCalls()).toBe(1);
    expect(result.authoredCompatibility).toBeUndefined();
    // No compatibility warning was injected for the undeclared target.
    expect(result.warnings.some((w) => w.toLowerCase().includes("compatibility"))).toBe(
      false,
    );
    // Observed fidelity is still derived (clean adapter → supported).
    expect(result.observedFidelity).toBe("supported");
    expect(result.files.length).toBeGreaterThan(0);
  });
});
