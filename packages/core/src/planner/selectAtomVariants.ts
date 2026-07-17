import type { Atom, ResolvedAtom, TargetPlatform } from "../schema/types.js";

export interface VariantSelection {
  /**
   * Adapter-ready atoms: for each atom the target's variant (or the default
   * `path`/`body`) has been swapped into place and the `variants` map removed,
   * so adapters stay variant-unaware. Atoms without variants pass through by
   * reference — a variant-free manifest plans byte-identically to before #133.
   */
  atoms: ResolvedAtom[];
  /**
   * Atoms that cannot be compiled for this target: they declare variants but
   * none matches `target` and there is no default `path`/`body`. Reported
   * through the same channel as adapter-unsupported atoms (#134) — merged into
   * the plan's `unsupportedAtoms`, never silently dropped.
   */
  unsupportedAtoms: string[];
  warnings: string[];
}

/**
 * Select each atom's source for the install target (#133) — BEFORE the adapter
 * boundary, so adapters receive ordinary atoms and never branch on variants.
 *
 * Per atom: exact-match `variants[target]` wins; otherwise the default
 * `path`/`body` applies at full fidelity (the default is target-agnostic by
 * construction); otherwise the atom is excluded from adapter input and
 * surfaced via `unsupportedAtoms` + a structured warning, which the planner's
 * `deriveObservedFidelity` (#134) turns into a `partial` observation.
 *
 * Atom identity is untouched: the returned atoms keep their manifest `id`, so
 * plans and lockfiles for different targets agree on what was installed even
 * though the compiled content differs.
 */
export function selectAtomVariants(
  resolved: ResolvedAtom[],
  target: TargetPlatform,
): VariantSelection {
  const atoms: ResolvedAtom[] = [];
  const unsupportedAtoms: string[] = [];
  const warnings: string[] = [];

  for (const r of resolved) {
    const variants = r.atom.variants;
    if (!variants || Object.keys(variants).length === 0) {
      atoms.push(r);
      continue;
    }
    const variant = variants[target];
    // Strip `variants` (and the superseded default source) from the clone the
    // adapter sees — one resolution authority, no second guess downstream.
    const { variants: _variants, path: _path, body: _body, ...rest } = r.atom;
    if (variant?.path !== undefined) {
      atoms.push({ ...r, atom: { ...rest, path: variant.path } as Atom });
    } else if (variant?.body !== undefined) {
      atoms.push({ ...r, atom: { ...rest, body: variant.body } as Atom });
    } else if (r.atom.path !== undefined) {
      atoms.push({ ...r, atom: { ...rest, path: r.atom.path } as Atom });
    } else if (r.atom.body !== undefined) {
      atoms.push({ ...r, atom: { ...rest, body: r.atom.body } as Atom });
    } else {
      const declared = Object.keys(variants).sort().join(", ");
      warnings.push(
        `Atom \`${r.atom.id}\` declares variants for ${declared} but none for target \`${target}\` and no default body. It cannot be compiled for this target.`,
      );
      unsupportedAtoms.push(r.atom.id);
    }
  }

  return { atoms, unsupportedAtoms, warnings };
}
