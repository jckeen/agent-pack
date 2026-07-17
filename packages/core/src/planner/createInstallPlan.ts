import type {
  AdapterOutputFile,
  AgentPackAdapter,
  AgentPackManifest,
  CompatibilityStatus,
  InstallPlan,
  RiskLevel,
  TargetPlatform,
} from "../schema/types.js";
import { computeRisk } from "../risk/computeRisk.js";
import { summarizePermissions } from "../permissions/summarizePermissions.js";
import { resolveAtoms } from "./resolveAtoms.js";

export interface CreateInstallPlanOptions {
  manifest: AgentPackManifest;
  packRoot: string;
  target: TargetPlatform;
  profile: string;
  adapter: AgentPackAdapter;
  onlyAtoms?: string[];
}

/**
 * Thrown when the manifest's authored `compatibility.targets[target]` declares
 * the requested target `unsupported` (#134). Raised BEFORE the adapter runs,
 * so no write plan is ever produced for a target the author refused.
 */
export class UnsupportedTargetError extends Error {
  readonly packId: string;
  readonly target: TargetPlatform;
  readonly notes: string | undefined;

  constructor(packId: string, target: TargetPlatform, notes?: string) {
    super(
      `Pack \`${packId}\` declares target \`${target}\` unsupported` +
        `${notes ? ` — ${notes}` : ""}. Refusing to plan for it; pick a target the pack supports.`,
    );
    this.name = "UnsupportedTargetError";
    this.packId = packId;
    this.target = target;
    this.notes = notes;
  }
}

/**
 * Compiler-observed fidelity for a target (#134): what the adapter actually
 * achieved, independent of what the manifest claims.
 *
 * Invariant: adapter-reported unsupported atoms can NEVER coexist with a
 * derived `supported` result — any dropped atom or adapter warning downgrades
 * the observation to `partial`. Only adapter output feeds this; plan-level
 * warnings (risk summaries, secret requirements) are consent surface, not
 * fidelity evidence.
 */
export function deriveObservedFidelity(
  adapterWarnings: readonly string[],
  unsupportedAtoms: readonly string[],
): CompatibilityStatus {
  if (unsupportedAtoms.length > 0) return "partial";
  return adapterWarnings.length === 0 ? "supported" : "partial";
}

/**
 * End-to-end planner: resolves atoms for the given profile, computes risk +
 * permissions, runs the adapter to produce a file plan, and surfaces
 * warnings (atom-level and adapter-level) in one object.
 *
 * Authored target compatibility is enforced here (#134): an `unsupported`
 * declaration refuses before the adapter runs; `partial`/`experimental`
 * declarations surface a structured warning the CLI turns into an explicit
 * acknowledgement gate. The plan reports the authored claim
 * (`authoredCompatibility`) separately from the compiler-observed result
 * (`observedFidelity`).
 *
 * Warning ordering is stable: authored compatibility caveat → declared
 * security risk_summary → risk reasons (only when overall risk is medium+) →
 * adapter warnings → secret requirements.
 */
export async function createInstallPlan(
  options: CreateInstallPlanOptions,
): Promise<InstallPlan> {
  const { manifest, packRoot, target, profile, adapter, onlyAtoms } = options;

  // Authored compatibility gate (#134): consult the manifest BEFORE resolving
  // or exporting anything. A target the author declared unsupported must not
  // produce a write plan at all. Undeclared targets stay exactly as before —
  // no declaration means no authored claim, not a refusal.
  const authored = manifest.compatibility?.targets?.[target];
  if (authored?.status === "unsupported") {
    throw new UnsupportedTargetError(manifest.metadata.id, target, authored.notes);
  }

  const resolved = resolveAtoms({ manifest, profile, onlyAtoms });
  const permissions = summarizePermissions(manifest, resolved);
  const risk = computeRisk(manifest, resolved, permissions);
  const adapterResult = await adapter.export({
    manifest,
    packRoot,
    resolvedAtoms: resolved,
    profile,
    target,
  });

  const warnings: string[] = [];
  if (authored && (authored.status === "partial" || authored.status === "experimental")) {
    warnings.push(
      `Target \`${target}\` compatibility is declared ${authored.status} by this pack` +
        `${authored.notes ? ` — ${authored.notes}` : ""}. Installing requires explicit acknowledgement.`,
    );
  }
  if (manifest.security?.risk_summary) warnings.push(manifest.security.risk_summary);

  // Include risk reasons only when the overall plan is non-trivial. For
  // `low` plans the reasons list is just "atom X is low" noise; for medium+
  // plans the reasons explain why the level rose. We surface every reason
  // (no dedupe — the audit trail is the value) when level is medium or above.
  const RISK_ORDER: Record<RiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  if (RISK_ORDER[risk.level] >= RISK_ORDER.medium) {
    warnings.push(...risk.reasons);
  }

  warnings.push(...adapterResult.warnings);

  for (const s of permissions.secrets) {
    warnings.push(
      `Secret \`${s.name}\` required${s.requiredFor.length ? ` for ${s.requiredFor.join(", ")}` : ""}.`,
    );
  }

  return {
    packId: manifest.metadata.id,
    packVersion: manifest.metadata.version,
    target,
    profile,
    atoms: resolved.map((r) => r.atom.id),
    atomTypes: resolved.map((r) => ({ id: r.atom.id, type: r.atom.type })),
    riskLevel: risk.level,
    permissions,
    warnings,
    files: adapterResult.files as AdapterOutputFile[],
    unsupportedAtoms: adapterResult.unsupportedAtoms,
    // Two distinct compatibility surfaces (#134): the author's claim as
    // written, and what the compiler observed doing the export. Derivation
    // uses ADAPTER warnings only — the merged `warnings` list above carries
    // consent items (risk summary, secrets) that say nothing about fidelity.
    ...(authored ? { authoredCompatibility: authored.status } : {}),
    observedFidelity: deriveObservedFidelity(
      adapterResult.warnings,
      adapterResult.unsupportedAtoms,
    ),
  };
}
