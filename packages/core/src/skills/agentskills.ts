/**
 * Agent Skills spec support (https://agentskills.io).
 *
 * AgentPack emits and consumes skill folders conformant with the Anthropic
 * Agent Skills specification. This module is the single source of truth for
 * the spec rules inside AgentPack:
 *
 *  - `validateSkillMdContent` is a TypeScript port of the reference
 *    validator (agentskills/agentskills → skills-ref/src/skills_ref/
 *    validator.py, audited 2026-06-12 at spec commit 5d4c1fd).
 *  - `renderSkillMd` synthesizes a conformant SKILL.md with YAML-safe
 *    serialization (a `: ` inside a description must not break parsing).
 *  - `conformSkillMd` normalizes a pass-through SKILL.md so the emitted
 *    copy conforms: the `name` is rewritten to match the emitted directory,
 *    unknown top-level frontmatter fields move under the spec's `metadata`
 *    passthrough, and over-limit fields are clamped — each with a warning.
 *  - `validateSkillAtoms` checks a pack's skill atoms against the spec at
 *    validate time (ingestion side: a manifest may point a skill atom at any
 *    spec-conformant skill folder).
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentPackManifest, ValidationIssue } from "../schema/types.js";
import { readAtomDirectory } from "../adapters/types.js";

export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500;

/** Top-level frontmatter fields the Agent Skills spec allows. */
export const AGENT_SKILLS_ALLOWED_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

export interface AgentSkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  "allowed-tools"?: string;
  metadata?: Record<string, string>;
}

interface SplitSkillMd {
  frontmatter: string;
  body: string;
}

/** Split `---` frontmatter from body using the reference parser's semantics. */
function splitFrontmatter(content: string): SplitSkillMd | null {
  if (!content.startsWith("---")) return null;
  const start = 3;
  const end = content.indexOf("---", start);
  if (end === -1) return null;
  return { frontmatter: content.slice(start, end), body: content.slice(end + 3) };
}

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const split = splitFrontmatter(content);
  if (!split) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(split.frontmatter);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function isNameChar(c: string): boolean {
  return c === "-" || /[\p{L}\p{N}]/u.test(c);
}

function validateName(rawName: unknown, dirName?: string): string[] {
  const errors: string[] = [];
  if (typeof rawName !== "string" || !rawName.trim()) {
    return ["Field `name` must be a non-empty string"];
  }
  const name = rawName.trim().normalize("NFKC");
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    errors.push(
      `Skill name \`${name}\` exceeds ${SKILL_NAME_MAX_LENGTH} character limit (${name.length} chars)`,
    );
  }
  if (name !== name.toLowerCase()) {
    errors.push(`Skill name \`${name}\` must be lowercase`);
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("Skill name cannot start or end with a hyphen");
  }
  if (name.includes("--")) {
    errors.push("Skill name cannot contain consecutive hyphens");
  }
  if (![...name].every(isNameChar)) {
    errors.push(
      `Skill name \`${name}\` contains invalid characters. Only letters, digits, and hyphens are allowed.`,
    );
  }
  if (dirName !== undefined && dirName.normalize("NFKC") !== name) {
    errors.push(`Directory name \`${dirName}\` must match skill name \`${name}\``);
  }
  return errors;
}

/**
 * Validate SKILL.md content against the Agent Skills spec. Returns a list of
 * error messages; empty means conformant. When `dirName` is given, the
 * spec's name↔directory match rule is checked too.
 */
export function validateSkillMdContent(content: string, dirName?: string): string[] {
  const split = splitFrontmatter(content);
  if (!split) {
    return ["SKILL.md must start with YAML frontmatter (---) and close it with ---"];
  }
  const metadata = parseFrontmatter(content);
  if (!metadata) {
    return ["SKILL.md frontmatter must be a valid YAML mapping"];
  }

  const errors: string[] = [];
  const extra = Object.keys(metadata).filter((k) => !AGENT_SKILLS_ALLOWED_FIELDS.has(k));
  if (extra.length > 0) {
    errors.push(
      `Unexpected fields in frontmatter: ${extra.sort().join(", ")}. Only ${[
        ...AGENT_SKILLS_ALLOWED_FIELDS,
      ]
        .sort()
        .join(", ")} are allowed.`,
    );
  }

  if (!("name" in metadata)) {
    errors.push("Missing required field in frontmatter: name");
  } else {
    errors.push(...validateName(metadata["name"], dirName));
  }

  if (!("description" in metadata)) {
    errors.push("Missing required field in frontmatter: description");
  } else {
    const description = metadata["description"];
    if (typeof description !== "string" || !description.trim()) {
      errors.push("Field `description` must be a non-empty string");
    } else if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
      errors.push(
        `Description exceeds ${SKILL_DESCRIPTION_MAX_LENGTH} character limit (${description.length} chars)`,
      );
    }
  }

  if ("compatibility" in metadata) {
    const compatibility = metadata["compatibility"];
    if (typeof compatibility !== "string") {
      errors.push("Field `compatibility` must be a string");
    } else if (compatibility.length > SKILL_COMPATIBILITY_MAX_LENGTH) {
      errors.push(
        `Compatibility exceeds ${SKILL_COMPATIBILITY_MAX_LENGTH} character limit (${compatibility.length} chars)`,
      );
    }
  }

  return errors;
}

/**
 * Normalize an arbitrary slug into a spec-conformant skill name: lowercase
 * letters/digits/hyphens, no edge or consecutive hyphens, ≤64 chars. Atom-id
 * slugs may legally contain uppercase, `.`, and `_` — all illegal in a skill
 * name — so every emitted skill directory passes through here.
 */
export function normalizeSkillSlug(raw: string): string {
  const normalized = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX_LENGTH)
    .replace(/-+$/g, "");
  return normalized || "skill";
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function toMetadataString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Render a spec-conformant SKILL.md. Field values are serialized through the
 * YAML library (never string-interpolated), so descriptions containing `: `,
 * quotes, or leading flow characters cannot break the frontmatter. The name
 * is slug-normalized and over-limit fields are clamped to the spec maxima.
 */
export function renderSkillMd(frontmatter: AgentSkillFrontmatter, body: string): string {
  const fm: Record<string, unknown> = {
    name: normalizeSkillSlug(frontmatter.name),
    description: clamp(frontmatter.description.trim(), SKILL_DESCRIPTION_MAX_LENGTH),
  };
  if (frontmatter.license !== undefined) fm["license"] = frontmatter.license;
  if (frontmatter.compatibility !== undefined) {
    fm["compatibility"] = clamp(frontmatter.compatibility, SKILL_COMPATIBILITY_MAX_LENGTH);
  }
  if (frontmatter["allowed-tools"] !== undefined) {
    fm["allowed-tools"] = frontmatter["allowed-tools"];
  }
  if (frontmatter.metadata && Object.keys(frontmatter.metadata).length > 0) {
    fm["metadata"] = frontmatter.metadata;
  }
  const yaml = stringifyYaml(fm, { lineWidth: 0 });
  return `---\n${yaml}---\n\n${body.trim()}\n`;
}

export interface ConformSkillMdResult {
  content: string;
  warnings: string[];
}

/**
 * Conform a pass-through SKILL.md to the spec for emission under `dirName`.
 *
 * Already-conformant content is returned byte-identical (authors' formatting
 * is preserved). Otherwise the smallest safe rewrite is applied and each
 * change is reported as a warning:
 *  - unparseable/missing frontmatter → synthesize from `fallback`, keeping
 *    the full original content as the body;
 *  - `name` ≠ emitted directory → rewrite to the directory name;
 *  - unknown top-level fields → relocate under `metadata` (spec passthrough);
 *  - over-limit description/compatibility → clamp to the spec maxima.
 */
export function conformSkillMd(
  content: string,
  dirName: string,
  fallback: { name: string; description: string },
): ConformSkillMdResult {
  if (validateSkillMdContent(content, dirName).length === 0) {
    return { content, warnings: [] };
  }

  const warnings: string[] = [];
  const split = splitFrontmatter(content);
  const parsed = parseFrontmatter(content);
  if (!split || !parsed) {
    warnings.push(
      "SKILL.md has no parseable YAML frontmatter; synthesized spec-conformant frontmatter (original content kept as the body).",
    );
    return {
      content: renderSkillMd({ name: dirName, description: fallback.description }, content),
      warnings,
    };
  }

  const metadata: Record<string, string> = {};
  const rawMetadata = parsed["metadata"];
  if (rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
    for (const [k, v] of Object.entries(rawMetadata)) {
      metadata[k] = toMetadataString(v);
    }
  }

  for (const key of Object.keys(parsed)) {
    if (AGENT_SKILLS_ALLOWED_FIELDS.has(key)) continue;
    if (key in metadata) {
      warnings.push(
        `Frontmatter field \`${key}\` is not in the Agent Skills spec and collides with an existing \`metadata.${key}\`; kept the metadata value and dropped the top-level field.`,
      );
      continue;
    }
    metadata[key] = toMetadataString(parsed[key]);
    warnings.push(
      `Frontmatter field \`${key}\` is not in the Agent Skills spec; moved it under \`metadata\`.`,
    );
  }

  const rawName = parsed["name"];
  const name = typeof rawName === "string" ? rawName.trim().normalize("NFKC") : "";
  if (name !== dirName) {
    warnings.push(
      `Skill name \`${name || "(missing)"}\` does not match the emitted directory \`${dirName}\`; rewrote the name to match (Agent Skills spec requires name = directory).`,
    );
  }

  const rawDescription = parsed["description"];
  let description =
    typeof rawDescription === "string" && rawDescription.trim() ? rawDescription : "";
  if (!description) {
    description = fallback.description;
    warnings.push(
      "SKILL.md `description` is missing or empty; used the atom description instead.",
    );
  } else if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    warnings.push(
      `SKILL.md \`description\` exceeds the spec's ${SKILL_DESCRIPTION_MAX_LENGTH}-character limit; clamped.`,
    );
  }

  const rawCompatibility = parsed["compatibility"];
  let compatibility: string | undefined;
  if (rawCompatibility !== undefined) {
    compatibility = toMetadataString(rawCompatibility);
    if (compatibility.length > SKILL_COMPATIBILITY_MAX_LENGTH) {
      warnings.push(
        `SKILL.md \`compatibility\` exceeds the spec's ${SKILL_COMPATIBILITY_MAX_LENGTH}-character limit; clamped.`,
      );
    }
  }

  const rawLicense = parsed["license"];
  const rawAllowedTools = parsed["allowed-tools"];

  return {
    content: renderSkillMd(
      {
        name: dirName,
        description,
        ...(rawLicense !== undefined ? { license: toMetadataString(rawLicense) } : {}),
        ...(compatibility !== undefined ? { compatibility } : {}),
        ...(rawAllowedTools !== undefined
          ? { "allowed-tools": toMetadataString(rawAllowedTools) }
          : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
      split.body.trim(),
    ),
    warnings,
  };
}

/**
 * Validate every skill atom's source folder against the Agent Skills spec.
 *
 * This is the ingestion-side check: a skill atom may point at any
 * spec-conformant skill folder (e.g. one authored against agentskills.io
 * directly) and AgentPack will carry it through unchanged. Non-conformant
 * sources are reported as warnings — the emit path auto-conforms the output,
 * so these are author hygiene, not export blockers. Missing directories are
 * not reported here; export-time strict mode owns that failure.
 */
export async function validateSkillAtoms(
  packRoot: string,
  manifest: AgentPackManifest,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const atom of manifest.atoms) {
    if (atom.type !== "skill") continue;
    const entries = await readAtomDirectory(packRoot, atom);
    if (entries.length === 0) continue;
    const skillMd =
      entries.find((e) => e.relPath === "SKILL.md") ??
      entries.find((e) => e.relPath === "skill.md");
    if (!skillMd) {
      issues.push({
        code: "skills.spec.missing-skill-md",
        path: atom.id,
        message: `Skill directory \`${atom.path}\` has no SKILL.md; export will synthesize a minimal one from the atom description.`,
        severity: "warning",
      });
      continue;
    }
    const slug = normalizeSkillSlug(atom.id.split(":")[1] ?? atom.name);
    for (const error of validateSkillMdContent(skillMd.content, slug)) {
      issues.push({
        code: "skills.spec",
        path: atom.id,
        message: `${error} (export auto-conforms the emitted copy)`,
        severity: "warning",
      });
    }
  }
  return issues;
}
