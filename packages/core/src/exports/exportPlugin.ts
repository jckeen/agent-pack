import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  AdapterOutputFile,
  AgentPackManifest,
  AtomType,
  InstallPlan,
} from "../schema/types.js";
import { getAdapter } from "../adapters/index.js";
import { loadManifest } from "../parser/loadManifest.js";
import { validateManifest } from "../validator/validateManifest.js";
import { createInstallPlan } from "../planner/createInstallPlan.js";
import { UnknownProfileError } from "../planner/resolveAtoms.js";
import { stableJsonStringify } from "../adapters/types.js";
import { summarizePortability, type PortabilitySummary } from "../portability.js";
import { normalizeSkillSlug, renderSkillMd } from "../skills/agentskills.js";

export interface ExportPluginOptions {
  /** Path to the pack directory or AGENTPACK.yaml file. */
  source: string;
  profile?: string;
  outDir: string;
  strict?: boolean;
  onlyAtoms?: string[];
  allowMissingBodies?: boolean;
  /** Also emit `.claude-plugin/marketplace.json` so the dir is a one-plugin marketplace. */
  marketplace?: boolean;
}

export interface ExportPluginResult {
  plan: InstallPlan;
  writtenFiles: string[];
  outDir: string;
  pluginName: string;
  portability: PortabilitySummary;
}

const MISSING_BODY_WARNING_PATTERNS = [
  /directory not found at/i,
  /minimal SKILL\.md/i,
  /not found at `/i,
];

/** A freshly-created plugin output file. */
function mk(filePath: string, content: string): AdapterOutputFile {
  return { path: filePath, content, action: "create" };
}

/**
 * Compile an AgentPack into a **Claude Code plugin** directory — the layout the
 * unified Directory and `/plugin install` consume, so one install reaches
 * Claude Code, Cowork, Desktop, and the web Directory.
 *
 * It reuses the `claude-code` adapter's rendering and RELOCATES the output from
 * project layout (`.claude/skills/…`, `CLAUDE.md`) into plugin layout
 * (`skills/…`, `commands/…`, `agents/…`, `hooks/hooks.json`, `.mcp.json`) plus
 * `.claude-plugin/plugin.json`. Instruction/rule content (which has no ambient
 * home outside Claude Code) is bundled into an on-invoke `*-guidance` skill so
 * it travels as far as it can — honestly, not as ambient behavior.
 */
export async function exportPlugin(
  options: ExportPluginOptions,
): Promise<ExportPluginResult> {
  const strict = options.strict ?? true;
  const allowMissing = options.allowMissingBodies ?? false;
  const loaded = await loadManifest(options.source);
  const validation = validateManifest(loaded.manifest);
  if (!validation.valid && strict) {
    const detail = validation.errors
      .map((e) => `[${e.code}] ${e.path}: ${e.message}`)
      .join("\n");
    throw new Error(`AgentPack manifest failed validation:\n${detail}`);
  }

  const adapter = getAdapter("claude-code");
  const profile = resolveProfile(loaded.manifest, options.profile);
  const plan = await createInstallPlan({
    manifest: loaded.manifest,
    packRoot: loaded.packRoot,
    target: "claude-code",
    profile,
    adapter,
    onlyAtoms: options.onlyAtoms,
  });

  if (strict && !allowMissing) {
    const missing = plan.warnings.filter((w) =>
      MISSING_BODY_WARNING_PATTERNS.some((rx) => rx.test(w)),
    );
    if (missing.length > 0) {
      throw new Error(
        `Plugin export aborted: atom body files missing — exporting would produce a degenerate plugin.\n` +
          missing.map((w) => `  • ${w}`).join("\n") +
          `\nFix the manifest paths, or pass --allow-missing.`,
      );
    }
  }

  const pluginName = kebab(loaded.manifest.metadata.slug);
  const pluginFiles = toPluginFiles(plan.files, loaded.manifest, pluginName);
  if (options.marketplace) {
    pluginFiles.push(
      mk(
        ".claude-plugin/marketplace.json",
        stableJsonStringify(marketplaceManifest(loaded.manifest, pluginName)),
      ),
    );
  }

  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const file of pluginFiles) {
    const absPath = path.resolve(outDir, file.path);
    if (!isInside(outDir, absPath)) {
      throw new Error(`Refusing to write outside outDir: ${file.path}`);
    }
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      file.content.endsWith("\n") ? file.content : `${file.content}\n`,
      "utf8",
    );
    written.push(path.relative(outDir, absPath));
  }

  const types = atomTypesForPlan(plan, loaded.manifest);
  return {
    plan,
    writtenFiles: written,
    outDir,
    pluginName,
    portability: summarizePortability(types),
  };
}

/** Relocate claude-code adapter output into Claude Code plugin layout. */
function toPluginFiles(
  files: AdapterOutputFile[],
  manifest: AgentPackManifest,
  pluginName: string,
): AdapterOutputFile[] {
  const out: AdapterOutputFile[] = [];
  out.push(
    mk(
      ".claude-plugin/plugin.json",
      stableJsonStringify(pluginManifest(manifest, pluginName)),
    ),
  );

  for (const f of files) {
    if (f.path === "CLAUDE.md") {
      // Instructions/rules have no ambient home outside Claude Code. Bundle as
      // an on-invoke skill so the guidance still reaches plugin-aware surfaces.
      // One normalized name is used for BOTH the directory and the frontmatter
      // (Agent Skills spec: name must equal directory, ≤64 chars).
      const guidanceName = normalizeSkillSlug(`${pluginName}-guidance`);
      out.push(
        mk(
          `skills/${guidanceName}/SKILL.md`,
          guidanceSkill(manifest, guidanceName, f.content),
        ),
      );
      continue;
    }
    if (f.path === ".claude/settings.json") {
      // Extract just the hooks block into the plugin's hooks/hooks.json.
      const hooks = extractHooks(f.content);
      if (hooks) {
        out.push(mk("hooks/hooks.json", stableJsonStringify({ hooks })));
      }
      continue;
    }
    if (f.path === ".mcp.json") {
      out.push(f); // plugin root, unchanged
      continue;
    }
    if (f.path.startsWith(".claude/")) {
      out.push(mk(f.path.slice(".claude/".length), f.content));
      continue;
    }
    // Anything else (READMEs etc.) passes through at root.
    out.push(f);
  }
  return out;
}

function pluginManifest(
  manifest: AgentPackManifest,
  pluginName: string,
): Record<string, unknown> {
  const m = manifest.metadata;
  const author = m.authors?.[0];
  const json: Record<string, unknown> = {
    $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
    name: pluginName,
    version: m.version,
    description: m.description,
  };
  if (author) {
    json.author = {
      name: author.name,
      ...(author.email ? { email: author.email } : {}),
      ...(author.url ? { url: author.url } : {}),
    };
  }
  if (m.homepage) json.homepage = m.homepage;
  if (m.repository) json.repository = m.repository;
  if (m.license) json.license = m.license;
  if (m.tags && m.tags.length > 0) json.keywords = m.tags;
  return json;
}

function marketplaceManifest(
  manifest: AgentPackManifest,
  pluginName: string,
): Record<string, unknown> {
  const m = manifest.metadata;
  return {
    $schema: "https://json.schemastore.org/claude-code-marketplace.json",
    name: `${pluginName}-marketplace`,
    owner: { name: m.publisher || m.authors?.[0]?.name || pluginName },
    description: m.description,
    plugins: [
      {
        name: pluginName,
        source: ".",
        description: m.description,
        version: m.version,
      },
    ],
  };
}

function guidanceSkill(manifest: AgentPackManifest, name: string, body: string): string {
  // Strip an existing top H1 to avoid a double title inside the skill body.
  const trimmed = body.replace(/^#\s.*\n+/, "").trimEnd();
  return renderSkillMd(
    {
      name,
      description: `${manifest.metadata.name} standards and rules. Bundled from the pack's instruction/rule atoms — ambient only in Claude Code; invoke this skill to apply the same guidance on Cowork, Desktop, and claude.ai.`,
    },
    trimmed,
  );
}

function extractHooks(settingsJson: string): unknown | null {
  try {
    const parsed = JSON.parse(settingsJson) as { hooks?: unknown };
    if (parsed.hooks && Object.keys(parsed.hooks).length > 0) {
      return parsed.hooks;
    }
  } catch {
    // Malformed settings — skip rather than emit broken hooks.
  }
  return null;
}

function atomTypesForPlan(plan: InstallPlan, manifest: AgentPackManifest): AtomType[] {
  const typeById = new Map<string, AtomType>(manifest.atoms.map((a) => [a.id, a.type]));
  return plan.atoms
    .map((id) => typeById.get(id))
    .filter((t): t is AtomType => t !== undefined);
}

function kebab(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "plugin"
  );
}

function resolveProfile(
  manifest: {
    profiles: Record<string, unknown>;
    exports?: { default_profile?: string };
  },
  requested?: string,
): string {
  if (requested) {
    if (!manifest.profiles[requested]) {
      throw new UnknownProfileError(requested, Object.keys(manifest.profiles));
    }
    return requested;
  }
  const declaredDefault = manifest.exports?.default_profile;
  if (declaredDefault && manifest.profiles[declaredDefault]) {
    return declaredDefault;
  }
  if (manifest.profiles.safe) return "safe";
  const declared = Object.keys(manifest.profiles).join(", ");
  throw new Error(
    `No profile specified and pack declares no \`exports.default_profile\` (or \`safe\`). Specify --profile <one of: ${declared}>.`,
  );
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
