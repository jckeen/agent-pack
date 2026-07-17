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
import { KNOWN_PERMISSION_CATEGORIES } from "../permissions/summarizePermissions.js";

function expandAtomGlob(pattern: string, atomIds: string[]): string[] {
  if (!pattern.includes("*")) return atomIds.includes(pattern) ? [pattern] : [];
  if (pattern === "*") return atomIds;
  const [prefix, suffix = ""] = pattern.split("*", 2) as [string, string?];
  return atomIds.filter((id) => id.startsWith(prefix ?? "") && id.endsWith(suffix ?? ""));
}

/**
 * Validate a parsed manifest object against the AgentPack schema, plus
 * semantic checks (duplicate atom IDs, profile references, permission
 * category sanity, atom-implied vs. declared permission consistency).
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

  // Atom id uniqueness (case-insensitive — published packs are referenced
  // by id, downstream systems may lowercase) + type-prefix consistency.
  const seenIds = new Map<string, number>();
  manifest.atoms.forEach((atom, idx) => {
    const normalized = atom.id.toLowerCase();
    const prior = seenIds.get(normalized);
    if (prior !== undefined) {
      errors.push({
        code: "atom.duplicate_id",
        path: `atoms[${idx}].id`,
        message: `Duplicate atom id \`${atom.id}\` (case-insensitive; first declared at atoms[${prior}]).`,
        severity: "error",
      });
    } else {
      seenIds.set(normalized, idx);
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
    // Target variants (#133): a variant whose path equals the atom's default
    // path is a no-op — the author probably meant to point at a per-target
    // file and would otherwise silently ship the default everywhere.
    for (const [variantTarget, variant] of Object.entries(atom.variants ?? {})) {
      if (variant?.path !== undefined && variant.path === atom.path) {
        warnings.push({
          code: "atom.variant_duplicates_default",
          path: `atoms[${idx}].variants.${variantTarget}`,
          message: `Atom \`${atom.id}\` variant for \`${variantTarget}\` points at the atom's default path \`${atom.path}\` — a no-op variant.`,
          severity: "warning",
        });
      }
    }
    // A variant-only atom (no default `path`/`body`) is dropped at install
    // time for every declared compatibility target it has no variant for
    // (#133) — surface the gap so the author sees it before a user does.
    const variantKeys = Object.keys(atom.variants ?? {});
    if (variantKeys.length > 0 && atom.path === undefined && atom.body === undefined) {
      const uncovered = Object.entries(manifest.compatibility?.targets ?? {})
        .filter(([, decl]) => decl.status !== "unsupported")
        .map(([t]) => t)
        .filter((t) => !variantKeys.includes(t));
      if (uncovered.length > 0) {
        warnings.push({
          code: "atom.variant_target_gap",
          path: `atoms[${idx}].variants`,
          message: `Atom \`${atom.id}\` has no default body and no variant for declared target(s) ${uncovered.join(", ")} — installs there will report it unsupported.`,
          severity: "warning",
        });
      }
    }
    // Permission category sanity — warn on unknown categories (we don't
    // hard-fail because future categories may be added by downstream
    // adapters, but unknown categories are suspicious enough to surface).
    for (const cat of atom.permissions ?? []) {
      if (!KNOWN_PERMISSION_CATEGORIES.includes(cat)) {
        warnings.push({
          code: "atom.unknown_permission",
          path: `atoms[${idx}].permissions`,
          message: `Atom \`${atom.id}\` declares unknown permission category \`${cat}\`. Known: ${KNOWN_PERMISSION_CATEGORIES.join(", ")}`,
          severity: "warning",
        });
      }
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

  // Default profile referenced in `exports.default_profile` must exist.
  const defaultProfile = manifest.exports?.default_profile;
  if (defaultProfile && !manifest.profiles[defaultProfile]) {
    errors.push({
      code: "exports.default_profile_unknown",
      path: "exports.default_profile",
      message: `\`exports.default_profile: ${defaultProfile}\` does not match any declared profile.`,
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

  // Atom-implied vs. declared permission consistency. If a hook atom or an
  // mcp_server with env exists, the pack-level `permissions:` block should
  // also declare the corresponding category. This is a warning, not an
  // error — packs may legitimately under-declare and rely on the active-
  // surface engine — but surfacing the gap helps reviewers spot drift.
  const hookAtoms = manifest.atoms.filter((a) => a.type === "hook");
  if (hookAtoms.length > 0) {
    if (
      !manifest.permissions?.shell ||
      manifest.permissions.shell.execution === "forbidden"
    ) {
      warnings.push({
        code: "permission.declared_shell_missing",
        path: "permissions.shell",
        message: `Pack contains hook atom(s) (${hookAtoms.map((a) => a.id).join(", ")}) but \`permissions.shell\` is missing or forbidden.`,
        severity: "warning",
      });
    }
  }
  const mcpWithEnv = manifest.atoms.filter((a) => {
    if (a.type !== "mcp_server") return false;
    const env = (a as { env?: Record<string, unknown> }).env;
    return env && Object.keys(env).length > 0;
  });
  if (
    mcpWithEnv.length > 0 &&
    (manifest.permissions?.secrets?.required ?? []).length === 0
  ) {
    warnings.push({
      code: "permission.declared_secrets_missing",
      path: "permissions.secrets.required",
      message: `Pack contains MCP server(s) with env (${mcpWithEnv.map((a) => a.id).join(", ")}) but \`permissions.secrets.required\` is empty.`,
      severity: "warning",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
