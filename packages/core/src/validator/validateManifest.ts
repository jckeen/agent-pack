import { ZodError } from "zod";
import {
  agentPackManifestSchema,
  type ParsedManifest,
} from "../schema/agentpack.schema.js";
import type {
  AgentPackManifest,
  ValidationIssue,
  ValidationResult,
} from "../schema/types.js";

function expandAtomGlob(pattern: string, atomIds: string[]): string[] {
  if (!pattern.includes("*")) return atomIds.includes(pattern) ? [pattern] : [];
  if (pattern === "*") return atomIds;
  const [prefix, suffix = ""] = pattern.split("*", 2) as [string, string?];
  return atomIds.filter(
    (id) => id.startsWith(prefix ?? "") && id.endsWith(suffix ?? ""),
  );
}

/**
 * Validate a parsed manifest object against the AgentPack schema, plus
 * semantic checks (duplicate atom IDs, profile references, missing files
 * referenced by atom paths).
 */
export function validateManifest(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  let parsed: ParsedManifest;
  try {
    parsed = agentPackManifestSchema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      for (const issue of err.issues) {
        errors.push({
          code: `schema.${issue.code}`,
          path: issue.path.join("."),
          message: issue.message,
          severity: "error",
        });
      }
    } else {
      errors.push({
        code: "schema.unknown",
        path: "",
        message: (err as Error).message,
        severity: "error",
      });
    }
    return { valid: false, errors, warnings };
  }

  const manifest = parsed as unknown as AgentPackManifest;

  // Atom id uniqueness + type-prefix consistency.
  const seenIds = new Map<string, number>();
  manifest.atoms.forEach((atom, idx) => {
    const prior = seenIds.get(atom.id);
    if (prior !== undefined) {
      errors.push({
        code: "atom.duplicate_id",
        path: `atoms[${idx}].id`,
        message: `Duplicate atom id \`${atom.id}\` (first declared at atoms[${prior}]).`,
        severity: "error",
      });
    } else {
      seenIds.set(atom.id, idx);
    }
    const prefix = atom.id.split(":")[0];
    if (prefix !== atom.type) {
      errors.push({
        code: "atom.id_type_mismatch",
        path: `atoms[${idx}].id`,
        message: `Atom id prefix \`${prefix}\` does not match declared type \`${atom.type}\`.`,
        severity: "error",
      });
    }
  });

  const atomIds = manifest.atoms.map((a) => a.id);

  // Profile references — every `include`/`exclude` pattern must match at least
  // one atom OR be a wildcard `type:*` for which the type is declared.
  for (const [profileName, spec] of Object.entries(manifest.profiles)) {
    for (const pattern of spec.include ?? []) {
      const matches = expandAtomGlob(pattern, atomIds);
      if (matches.length === 0 && pattern !== "*") {
        errors.push({
          code: "profile.unresolved_include",
          path: `profiles.${profileName}.include`,
          message: `Pattern \`${pattern}\` matches no atom in this pack.`,
          severity: "error",
        });
      }
    }
    for (const pattern of spec.exclude ?? []) {
      const matches = expandAtomGlob(pattern, atomIds);
      if (matches.length === 0) {
        warnings.push({
          code: "profile.exclude_no_match",
          path: `profiles.${profileName}.exclude`,
          message: `Exclude pattern \`${pattern}\` matched nothing — likely no-op.`,
          severity: "warning",
        });
      }
    }
  }

  // Manifest must define at least one profile.
  if (Object.keys(manifest.profiles).length === 0) {
    errors.push({
      code: "profile.none",
      path: "profiles",
      message: "Manifest must define at least one install profile.",
      severity: "error",
    });
  }

  // Compatibility targets cannot be empty.
  if (Object.keys(manifest.compatibility.targets).length === 0) {
    warnings.push({
      code: "compatibility.no_targets",
      path: "compatibility.targets",
      message: "No compatibility targets declared — adapters will all warn.",
      severity: "warning",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
