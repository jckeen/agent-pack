// Maps a parsed CLAUDE.md/AGENTS.md into an AgentPack manifest + atom files.
// No I/O — `writeImport` (in ./index.ts) handles the filesystem.

import { stringify } from "yaml";
import type { AgentPackManifest, Atom, TargetPlatform } from "../schema/types.js";
import { importedCompatibility } from "./importCompatibility.js";
import type { ParsedClaudeMd, ParseWarning } from "./parseClaudeMd.js";

export interface BuildManifestOptions {
  /** `publisher.slug` — already validated by the caller. */
  id: string;
  /** Human-readable pack name. Defaults to the title or a slug-derived name. */
  name?: string;
  /** Pack version. */
  version?: string;
  /** Native source runtime when known; standalone text defaults to generic. */
  source?: TargetPlatform;
}

export interface ImportFile {
  /** Path relative to the pack root (e.g. `atoms/rules/foo.yaml`). */
  relativePath: string;
  content: string;
}

export interface BuildManifestResult {
  manifest: AgentPackManifest;
  files: ImportFile[];
  warnings: ParseWarning[];
}

const RULE_KEYWORD_RE =
  /\b(auth|authentication|authorization|security|secret|git|permission|verification|verify|never|always)\b/i;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MUST_NOT_PREFIX_RE = /^(never|don't|do not|must not)\b[:\s,-]*/i;

const PROSE_CAP = 300;

export function slugify(input: string): string {
  let slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (slug === "") slug = "section";
  // Avoid a leading digit only-issue? id regex permits leading digit. But the
  // atom-id slug regex requires the slug to start `[a-z0-9]`, which a digit
  // satisfies, so no special handling needed.
  if (WINDOWS_RESERVED_RE.test(slug)) slug = `${slug}-section`;
  return slug;
}

/** Promote a heading to a rule when it names a governance/security concern. */
function isRuleHeading(heading: string): boolean {
  if (/definition of done/i.test(heading)) return true;
  return RULE_KEYWORD_RE.test(heading);
}

interface ParsedBullets {
  must: string[];
  must_not: string[];
}

/** Split a section body's top-level bullets into must / must_not. */
function bulletsToBehavior(body: string): ParsedBullets | null {
  const lines = body.split("\n");
  const bullets: string[] = [];
  let current: string | null = null;
  const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
  for (const line of lines) {
    const m = line.match(BULLET_RE);
    if (m) {
      if (current !== null) bullets.push(current);
      current = m[1]!.trim();
    } else if (current !== null) {
      const trimmed = line.trim();
      if (trimmed === "") {
        // Blank line ends the current bullet.
        bullets.push(current);
        current = null;
      } else {
        // Continuation (wrapped) line — fold into the current bullet so
        // multi-line bullets aren't truncated to their first physical line.
        current = `${current} ${trimmed}`;
      }
    }
  }
  if (current !== null) bullets.push(current);
  if (bullets.length === 0) return null;
  const must: string[] = [];
  const must_not: string[] = [];
  for (const bullet of bullets) {
    const stripped = bullet.replace(MUST_NOT_PREFIX_RE, "").trim();
    if (MUST_NOT_PREFIX_RE.test(bullet) && stripped.length > 0) {
      must_not.push(stripped);
    } else {
      must.push(bullet);
    }
  }
  return { must, must_not };
}

/** Collapse a section body to a single prose sentence (rule fallback). */
function bodyToProse(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= PROSE_CAP) return flat || "Follow this guidance.";
  return `${flat.slice(0, PROSE_CAP).trimEnd()}…`;
}

/** A one-line description for an atom, derived from heading/body. */
function deriveDescription(heading: string, body: string): string {
  const firstLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^[-*+#>]/.test(l));
  const candidate = (firstLine ?? `${heading} guidance`).replace(/\s+/g, " ").trim();
  const desc = candidate.length > 0 ? candidate : `${heading} guidance`;
  return desc.length > PROSE_CAP ? `${desc.slice(0, PROSE_CAP).trimEnd()}…` : desc;
}

function hasUnstructuredRuleContent(body: string): boolean {
  const bulletRe = /^\s*(?:[-*+]|\d+[.)])\s+.*\S\s*$/;
  let inBullet = false;
  for (const line of body.split("\n")) {
    if (bulletRe.test(line)) {
      inBullet = true;
    } else if (line.trim() === "") {
      inBullet = false;
    } else if (!inBullet) {
      return true;
    }
  }
  return false;
}

export function buildManifest(
  parsed: ParsedClaudeMd,
  opts: BuildManifestOptions,
): BuildManifestResult {
  if (parsed.sections.length === 0) {
    throw new Error(
      "No `## ` sections found — nothing to import. A CLAUDE.md needs at least one second-level heading to become an atom.",
    );
  }

  const slug = opts.id.split(".").slice(1).join(".") || opts.id;
  // `??` would let an explicit empty/whitespace `--name ""` through and produce
  // a `metadata.name: ""` that fails the schema's `min(1)` — a written-but-
  // invalid pack. Coerce blank user input to the next fallback at the core
  // boundary so every caller (CLI, programmatic) is safe.
  const name = opts.name?.trim() || parsed.title?.trim() || slug;
  const version = opts.version?.trim() || "0.1.0";

  const files: ImportFile[] = [];
  const atoms: Atom[] = [];
  const warnings: ParseWarning[] = [...parsed.warnings];
  const usedSlugs = new Map<string, number>();

  for (const section of parsed.sections) {
    const base = slugify(section.heading);
    let finalSlug = base;
    const seen = usedSlugs.get(base);
    if (seen !== undefined) {
      const next = seen + 1;
      usedSlugs.set(base, next);
      finalSlug = `${base}-${next}`;
    } else {
      usedSlugs.set(base, 1);
    }

    const description = deriveDescription(section.heading, section.body);

    if (isRuleHeading(section.heading)) {
      const bullets = bulletsToBehavior(section.body);
      if (bullets !== null && hasUnstructuredRuleContent(section.body)) {
        warnings.push({
          line: section.lineStart,
          message: `Rule section \`${section.heading}\` contains prose outside list items; structured rule output is lossy.`,
        });
      }
      if (bullets === null && section.body.replace(/\s+/g, " ").trim().length > PROSE_CAP) {
        warnings.push({
          line: section.lineStart,
          message: `Rule section \`${section.heading}\` exceeds ${PROSE_CAP} characters; prose rule output was truncated.`,
        });
      }
      const behavior =
        bullets !== null
          ? { must: bullets.must, must_not: bullets.must_not }
          : { must: [bodyToProse(section.body)], must_not: [] as string[] };
      const ruleObj: Record<string, unknown> = {
        id: finalSlug,
        name: section.heading,
        severity: "required",
        behavior,
      };
      const relativePath = `atoms/rules/${finalSlug}.yaml`;
      files.push({
        relativePath,
        content: stringify(ruleObj, { lineWidth: 0 }),
      });
      atoms.push({
        id: `rule:${finalSlug}`,
        type: "rule",
        name: section.heading,
        description,
        path: relativePath,
        risk_level: "low",
        permissions: [],
      });
    } else {
      const relativePath = `atoms/instructions/${finalSlug}.md`;
      const md = `# ${section.heading}\n\n${section.body}\n`;
      files.push({ relativePath, content: md });
      atoms.push({
        id: `instruction:${finalSlug}`,
        type: "instruction",
        name: section.heading,
        description,
        path: relativePath,
        risk_level: "low",
        permissions: [],
      });
    }
  }

  const manifest: AgentPackManifest = {
    agentpack: "1.0",
    metadata: {
      id: opts.id,
      name,
      slug,
      description: "Imported from CLAUDE.md",
      version,
      license: "MIT",
      publisher: opts.id.split(".")[0]!,
    },
    compatibility: {
      targets: importedCompatibility(
        opts.source ?? "generic",
        warnings.length > 0 ? "partial" : "supported",
      ),
    },
    permissions: {},
    security: { risk_level: "low" },
    profiles: {
      all: {
        description: "All imported atoms.",
        include: ["*"],
      },
    },
    atoms,
    exports: { default_profile: "all" },
  };

  return { manifest, files, warnings };
}
