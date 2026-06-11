import type {
  AgentPackManifest,
  Atom,
  ProfileSpec,
  ResolvedAtom,
} from "../schema/types.js";

function expandPattern(pattern: string, atoms: Atom[]): Atom[] {
  if (!pattern.includes("*")) {
    return atoms.filter((a) => a.id === pattern);
  }
  if (pattern === "*") return atoms.slice();
  const [prefix, suffix = ""] = pattern.split("*", 2) as [string, string?];
  return atoms.filter(
    (a) => a.id.startsWith(prefix ?? "") && a.id.endsWith(suffix ?? ""),
  );
}

export interface ResolveAtomsOptions {
  manifest: AgentPackManifest;
  profile: string;
  onlyAtoms?: string[];
}

/**
 * Resolve the concrete list of atoms that should be installed for a given
 * profile, applying include/exclude patterns deterministically (atoms keep
 * manifest order).
 */
export class UnknownProfileError extends Error {
  constructor(profile: string, declared: string[]) {
    super(`Unknown profile \`${profile}\`. Declared: ${declared.join(", ")}`);
    this.name = "UnknownProfileError";
  }
}

export function resolveAtoms(options: ResolveAtomsOptions): ResolvedAtom[] {
  const { manifest, profile, onlyAtoms } = options;
  const spec: ProfileSpec | undefined = manifest.profiles[profile];
  if (!spec) {
    throw new UnknownProfileError(profile, Object.keys(manifest.profiles));
  }
  const allAtoms = manifest.atoms;

  // Build included set (deterministic order following manifest order).
  const includedIds = new Set<string>();
  const reasonById = new Map<string, ResolvedAtom["reason"]>();
  const sourceById = new Map<string, string>();

  const includePatterns = spec.include ?? [];
  if (includePatterns.length === 0) {
    // No include block → include everything in this profile.
    for (const atom of allAtoms) {
      includedIds.add(atom.id);
      reasonById.set(atom.id, "default");
      sourceById.set(atom.id, "(profile default — all atoms)");
    }
  } else {
    for (const pattern of includePatterns) {
      const matches = expandPattern(pattern, allAtoms);
      const isWildcard = pattern.includes("*");
      for (const atom of matches) {
        if (!includedIds.has(atom.id)) {
          includedIds.add(atom.id);
          reasonById.set(atom.id, isWildcard ? "wildcard" : "include");
          sourceById.set(atom.id, pattern);
        }
      }
    }
  }

  for (const pattern of spec.exclude ?? []) {
    const matches = expandPattern(pattern, allAtoms);
    for (const atom of matches) includedIds.delete(atom.id);
  }

  if (onlyAtoms && onlyAtoms.length > 0) {
    const filter = new Set(onlyAtoms);
    for (const id of [...includedIds]) {
      if (!filter.has(id)) includedIds.delete(id);
    }
  }

  return allAtoms
    .filter((a) => includedIds.has(a.id))
    .map<ResolvedAtom>((atom) => ({
      atom,
      reason: reasonById.get(atom.id) ?? "include",
      source: sourceById.get(atom.id) ?? "(unknown)",
    }));
}
