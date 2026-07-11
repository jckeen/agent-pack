import * as fs from "node:fs/promises";
import * as path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { parse as parseYaml } from "yaml";

import type {
  AgentPackManifest,
  Atom,
  AtomType,
  McpAtom,
  ResolvedAtom,
} from "../schema/types.js";
import { loadManifest } from "../parser/loadManifest.js";
import { validateManifest } from "../validator/validateManifest.js";
import { resolveAtoms, UnknownProfileError } from "../planner/resolveAtoms.js";
import {
  readAtomDirectory,
  readAtomFile,
  readPackRelativeFile,
} from "../adapters/types.js";
import {
  conformSkillMd,
  normalizeSkillSlug,
  renderSkillMd,
  SKILL_DESCRIPTION_MAX_LENGTH,
} from "../skills/agentskills.js";
import { isCredentialFreeHttpUrl } from "../adapters/commandGate.js";
import { invalidChatMcpFields } from "../adapters/mcpValidation.js";

export interface ExportChatOptions {
  /** Path to the pack directory or AGENTPACK.yaml file. */
  source: string;
  profile?: string;
  /** Directory to write the chat install artifacts into. */
  outDir: string;
  strict?: boolean;
  onlyAtoms?: string[];
}

/** Whether a compiled skill is a real Skill atom or a bridged on-invoke one. */
export type ChatSkillKind = "native" | "on-invoke";

export interface ChatSkillArtifact {
  atomId: string;
  /** The spec-normalized skill name (= directory inside the ZIP). */
  skillName: string;
  /** `native` for skill atoms; `on-invoke` for bridged instruction/rule/command. */
  kind: ChatSkillKind;
  /** Absolute path to the emitted `<name>.zip`. */
  zipPath: string;
  /** Conformance warnings raised while emitting the SKILL.md. */
  warnings: string[];
}

/** A remote MCP connector recipe (claude.ai has no install API — instructions only). */
export interface ChatConnector {
  atom: string;
  name: string;
  description: string;
  transport: "http" | "sse";
  url: string;
  auth: { scheme: string; scopes: string[] };
  /** Optional tool catalogue retained from imported connector descriptors. */
  tools?: Array<Record<string, unknown>>;
  /** Secrets the user must supply when adding the connector. */
  required_secrets: Array<{ name: string; description?: string }>;
  /** Copy-paste / QR install recipe text. */
  install_recipe: string;
}

export interface ChatConnectorsDoc {
  pack: string;
  version: string;
  connectors: ChatConnector[];
  /** Org-provisioning checklist for Team/Enterprise admins. */
  org_provisioning_checklist: string;
}

/** Per-atom portability verdict for the Claude Chat surface. */
export interface ChatPortabilityEntry {
  atomId: string;
  type: AtomType;
  /** True if the atom reaches claude.ai in some form. */
  portable: boolean;
  /** What it was downgraded to when not natively supported, if anything. */
  downgradedTo?: "skill" | "connector" | "project-instructions";
  /** Honest one-line explanation. */
  note: string;
}

export interface ExportChatResult {
  outDir: string;
  /** Every emitted skill ZIP (native + on-invoke). */
  skills: ChatSkillArtifact[];
  /** Remote connector recipes, empty if the pack has none. */
  connectors: ChatConnector[];
  /** Per-atom portability report. */
  report: ChatPortabilityEntry[];
  /** Relative paths of every file written into outDir. */
  writtenFiles: string[];
}

/**
 * Compile an AgentPack into the artifacts a **claude.ai (Claude Chat)** user or
 * admin installs. Chat has no bundle format — Skills install one ZIP at a time,
 * custom MCP connectors are added by URL, and there is no ambient-instructions
 * loader — so this fans one pack out into N copy-paste install steps:
 *
 *  1. `skills/<atom>.zip` — one uploadable Agent Skills ZIP per `skill` atom,
 *     plus on-invoke skills bridged from `instruction` / `rule` / procedure-
 *     `command` atoms (clearly flagged as on-invoke, NOT ambient).
 *  2. `connectors.json` — per remote (`http`/`sse`) `mcp_server` atom: URL +
 *     auth scheme + scopes as a copy-paste/QR recipe, plus an org-provisioning
 *     checklist. AgentPack can't auto-install into Chat (no API) — instructions.
 *  3. `project-instructions.md` — the instruction/rule set as a Project custom-
 *     instructions block (the ambient-within-project alternative).
 *  4. `README.md` — ordered install steps + a per-atom portability report
 *     marking `command`/`subagent`/`hook`/`plugin` as not-portable (downgraded
 *     to a skill where semantically possible).
 */
export async function exportChat(options: ExportChatOptions): Promise<ExportChatResult> {
  const strict = options.strict ?? true;
  const loaded = await loadManifest(options.source);
  const validation = validateManifest(loaded.manifest);
  if (!validation.valid && strict) {
    const detail = validation.errors
      .map((e) => `[${e.code}] ${e.path}: ${e.message}`)
      .join("\n");
    throw new Error(`AgentPack manifest failed validation:\n${detail}`);
  }

  const profile = resolveProfile(loaded.manifest, options.profile);
  const resolved = resolveAtoms({
    manifest: loaded.manifest,
    profile,
    onlyAtoms: options.onlyAtoms,
  });

  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const written: string[] = [];

  const write = async (relPath: string, content: string | Uint8Array) => {
    const abs = path.join(outDir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    written.push(relPath);
  };

  // ---------- 1. Skill ZIPs ----------
  const skills: ChatSkillArtifact[] = [];
  const usedNames = new Set<string>();
  for (const r of resolved) {
    const artifact = await compileSkill(
      r.atom,
      loaded.packRoot,
      loaded.manifest,
      usedNames,
    );
    if (artifact) {
      await write(`skills/${artifact.skillName}.zip`, artifact.zipBytes);
      skills.push({
        atomId: artifact.atomId,
        skillName: artifact.skillName,
        kind: artifact.kind,
        zipPath: path.join(outDir, `skills/${artifact.skillName}.zip`),
        warnings: artifact.warnings,
      });
    }
  }

  // ---------- 2. connectors.json ----------
  const connectors = await buildConnectors(resolved, loaded.packRoot);
  if (connectors.length > 0) {
    const doc: ChatConnectorsDoc = {
      pack: loaded.manifest.metadata.id,
      version: loaded.manifest.metadata.version,
      connectors,
      org_provisioning_checklist: orgChecklist(connectors),
    };
    await write("connectors.json", `${JSON.stringify(doc, null, 2)}\n`);
  }

  // ---------- 3. project-instructions.md ----------
  await write(
    "project-instructions.md",
    await projectInstructions(resolved, loaded.packRoot, loaded.manifest),
  );

  // ---------- 4. README + portability report ----------
  const report = buildReport(
    resolved,
    new Set(connectors.map((connector) => connector.atom)),
  );
  const readmeContent = readme(loaded.manifest, profile, skills, connectors, report);
  await write("README.md", readmeContent);

  return {
    outDir,
    skills,
    connectors,
    report,
    writtenFiles: written.sort(),
  };
}

// ---------------------------------------------------------------------------
// Skill compilation
// ---------------------------------------------------------------------------

interface CompiledSkill {
  atomId: string;
  skillName: string;
  kind: ChatSkillKind;
  zipBytes: Uint8Array;
  warnings: string[];
}

/** Atom types compiled into an on-invoke (bridged) skill. */
const ON_INVOKE_TYPES = new Set<AtomType>(["instruction", "rule", "command"]);

async function compileSkill(
  atom: Atom,
  packRoot: string,
  manifest: AgentPackManifest,
  usedNames: Set<string>,
): Promise<CompiledSkill | null> {
  if (atom.type === "skill") {
    return compileNativeSkill(atom, packRoot, usedNames);
  }
  if (ON_INVOKE_TYPES.has(atom.type)) {
    return compileOnInvokeSkill(atom, packRoot, manifest, usedNames);
  }
  return null;
}

async function compileNativeSkill(
  atom: Atom,
  packRoot: string,
  usedNames: Set<string>,
): Promise<CompiledSkill> {
  const name = uniqueName(atom.id.split(":")[1] ?? atom.name, usedNames);
  const entries = await readAtomDirectory(packRoot, atom);
  const skillMd =
    entries.find((e) => e.relPath === "SKILL.md") ??
    entries.find((e) => e.relPath === "skill.md");

  const warnings: string[] = [];
  let skillContent: string;
  if (skillMd) {
    const conformed = conformSkillMd(skillMd.content, name, {
      name,
      description: clampDescription(atom.description),
    });
    skillContent = conformed.content;
    warnings.push(...conformed.warnings);
  } else {
    skillContent = renderSkillMd(
      { name, description: clampDescription(atom.description) },
      `# ${atom.name}\n\n${atom.description}`,
    );
    warnings.push(
      `Skill directory \`${atom.path}\` has no SKILL.md; synthesized a minimal one from the atom description.`,
    );
  }

  // Carry every non-SKILL.md companion file into the ZIP under the skill dir.
  const files: Record<string, Uint8Array> = {
    [`${name}/SKILL.md`]: strToU8(skillContent),
  };
  for (const e of entries) {
    if (e.relPath === "SKILL.md" || e.relPath === "skill.md") continue;
    files[`${name}/${e.relPath}`] = strToU8(e.content);
  }

  return {
    atomId: atom.id,
    skillName: name,
    kind: "native",
    zipBytes: zipSync(files),
    warnings,
  };
}

async function compileOnInvokeSkill(
  atom: Atom,
  packRoot: string,
  manifest: AgentPackManifest,
  usedNames: Set<string>,
): Promise<CompiledSkill> {
  const name = uniqueName(atom.id.split(":")[1] ?? atom.name, usedNames);
  const body = await onInvokeBody(atom, packRoot);
  const description = clampDescription(`[on-invoke, not ambient] ${atom.description}`);
  const banner =
    `> **On-invoke skill (not ambient).** Bridged from the \`${atom.type}\` atom ` +
    `\`${atom.id}\` in ${manifest.metadata.name}. Claude Chat has no ambient ` +
    `instruction loader, so this guidance applies only when this skill is invoked — ` +
    `it does NOT run on every message the way a CLAUDE.md rule would in Claude Code.`;
  const content = renderSkillMd(
    { name, description },
    `# ${atom.name}\n\n${banner}\n\n${body}`,
  );
  return {
    atomId: atom.id,
    skillName: name,
    kind: "on-invoke",
    zipBytes: zipSync({ [`${name}/SKILL.md`]: strToU8(content) }),
    warnings: [],
  };
}

/** Best-effort human-readable body for a bridged atom. */
async function onInvokeBody(atom: Atom, packRoot: string): Promise<string> {
  if (atom.type === "command") {
    const parsed = await parseAtomYaml(packRoot, atom);
    const promptPath = parsed?.["prompt"];
    if (typeof promptPath === "string" && promptPath.length > 0) {
      const prompt = await readRelativeFile(packRoot, promptPath);
      if (prompt) return stripLeadingH1(prompt.trim());
    }
    return atom.description;
  }
  if (atom.type === "rule") {
    const parsed = await parseAtomYaml(packRoot, atom);
    const lines = ruleLines(parsed);
    if (lines.length > 0) return lines.join("\n");
    return atom.description;
  }
  // instruction → the markdown body verbatim.
  const file = await readAtomFile(packRoot, atom);
  if (file && file.trim()) return stripLeadingH1(file.trim());
  return atom.description;
}

function ruleLines(parsed: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  const behavior = parsed?.["behavior"] as
    { must?: unknown[]; must_not?: unknown[] } | undefined;
  const must = (behavior?.must ?? []).filter((s): s is string => typeof s === "string");
  const mustNot = (behavior?.must_not ?? []).filter(
    (s): s is string => typeof s === "string",
  );
  if (must.length > 0) {
    out.push("## Must", "", ...must.map((s) => `- ${s}`), "");
  }
  if (mustNot.length > 0) {
    out.push("## Must not", "", ...mustNot.map((s) => `- ${s}`), "");
  }
  return out;
}

// ---------------------------------------------------------------------------
// connectors.json
// ---------------------------------------------------------------------------

async function buildConnectors(
  resolved: ResolvedAtom[],
  packRoot: string,
): Promise<ChatConnector[]> {
  const connectors: ChatConnector[] = [];
  for (const r of resolved) {
    if (r.atom.type !== "mcp_server") continue;
    const a = r.atom as McpAtom;
    if (hasCodexOnlyMcpConfig(a)) continue;
    const body = await parseAtomYaml(packRoot, a);
    if (!body) continue;
    const combined = { ...body, ...a } as Record<string, unknown>;
    if (invalidChatMcpFields(combined).length > 0) continue;
    const transport = a.transport ?? "stdio";
    // Chat custom connectors are remote MCP only; stdio servers ship as .mcpb.
    if (transport !== "http" && transport !== "sse") continue;
    if (!isCredentialFreeHttpUrl(a.url)) continue;

    const requiredSecrets: Array<{ name: string; description?: string }> = [];
    for (const [key, spec] of Object.entries(a.env ?? {})) {
      const required = typeof spec === "object" ? (spec.required ?? false) : false;
      if (!required) continue;
      const description = typeof spec === "object" ? spec.description : undefined;
      requiredSecrets.push({ name: key, ...(description ? { description } : {}) });
    }

    const auth = connectorAuth(a, combined);
    const tools = Array.isArray(combined["tools"])
      ? (combined["tools"] as Array<Record<string, unknown>>)
      : undefined;
    connectors.push({
      atom: a.id,
      name: a.name,
      description: a.description,
      transport,
      url: a.url,
      auth,
      ...(tools ? { tools } : {}),
      required_secrets: requiredSecrets,
      install_recipe: installRecipe(a, auth, requiredSecrets),
    });
  }
  return connectors;
}

/** Read auth scheme + scopes from the atom body yaml when present. */
function connectorAuth(
  atom: McpAtom,
  body: Record<string, unknown> | null,
): { scheme: string; scopes: string[] } {
  // The atom body yaml may carry an `auth: { scheme, scopes }` block.
  const auth = body?.["auth"] as { scheme?: string; scopes?: unknown } | undefined;
  const scheme = typeof auth?.scheme === "string" ? auth.scheme : inferScheme(atom);
  const scopes = Array.isArray(auth?.scopes)
    ? auth.scopes.filter((s): s is string => typeof s === "string")
    : [];
  return { scheme, scopes };
}

function inferScheme(atom: McpAtom): string {
  // A connector that needs a secret token but declares no scheme is treated as
  // bearer-token; otherwise assume the connector is open / handles its own auth.
  const hasSecret = Object.values(atom.env ?? {}).some(
    (spec) => typeof spec === "object" && spec.required,
  );
  return hasSecret ? "bearer" : "none";
}

function installRecipe(
  atom: McpAtom,
  auth: { scheme: string; scopes: string[] },
  secrets: Array<{ name: string }>,
): string {
  const steps = [
    `Open claude.ai → Settings → Connectors → "Add custom connector".`,
    `Name: ${atom.name}`,
    `Remote MCP server URL: ${atom.url}`,
  ];
  if (auth.scheme !== "none") {
    steps.push(
      `Auth: ${auth.scheme}${auth.scopes.length > 0 ? ` (scopes: ${auth.scopes.join(", ")})` : ""}`,
    );
  }
  if (secrets.length > 0) {
    steps.push(
      `Provide secret(s) when prompted: ${secrets.map((s) => s.name).join(", ")} (never paste these into a chat).`,
    );
  }
  steps.push(
    `Mobile: scan the connector QR from Settings → Connectors to add it on the Claude app (install beta).`,
  );
  return steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

function orgChecklist(connectors: ChatConnector[]): string {
  const lines = [
    "Org provisioning (Team / Enterprise admins):",
    "",
    "- Confirm the pack's connectors are allowed by your org's connector policy.",
    "- Pre-approve each remote MCP URL in the admin console so members can add it.",
    "- Decide whether connectors are admin-installed org-wide or self-served per member.",
    "- Rotate and scope the OAuth credentials below to least privilege before sharing.",
    "",
  ];
  for (const c of connectors) {
    lines.push(
      `- ${c.name} (${c.url}) — auth: ${c.auth.scheme}${c.auth.scopes.length > 0 ? `, scopes: ${c.auth.scopes.join(", ")}` : ""}.`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// project-instructions.md
// ---------------------------------------------------------------------------

async function projectInstructions(
  resolved: ResolvedAtom[],
  packRoot: string,
  manifest: AgentPackManifest,
): Promise<string> {
  const m = manifest.metadata;
  const lines: string[] = [
    `# ${m.name} — Project custom instructions`,
    "",
    `> ${m.description}`,
    "",
    `Paste this into a claude.ai Project's custom instructions. This is the ` +
      `ambient-within-a-Project alternative to the on-invoke skills — Chat has no ` +
      `global instruction loader, so ambient guidance only applies inside a Project.`,
    "",
  ];

  const instructions = resolved.filter((r) => r.atom.type === "instruction");
  for (const r of instructions) {
    const body = await readAtomFile(packRoot, r.atom);
    const text = body && body.trim() ? stripLeadingH1(body.trim()) : r.atom.description;
    lines.push(`## ${r.atom.name}`, "", text, "");
  }

  const rules = resolved.filter((r) => r.atom.type === "rule");
  if (rules.length > 0) {
    lines.push("## Rules", "");
    for (const r of rules) {
      lines.push(`### ${r.atom.name}`, "", `> ${r.atom.description}`, "");
      const parsed = await parseAtomYaml(packRoot, r.atom);
      const ruleBody = ruleLines(parsed);
      if (ruleBody.length > 0) lines.push(...ruleBody);
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// README + report
// ---------------------------------------------------------------------------

function buildReport(
  resolved: ResolvedAtom[],
  connectorAtoms: ReadonlySet<string>,
): ChatPortabilityEntry[] {
  return resolved.map((r) => reportEntry(r.atom, connectorAtoms));
}

function hasCodexOnlyMcpConfig(atom: McpAtom): boolean {
  const keys = (atom as McpAtom & { codex_only_config?: unknown })["codex_only_config"];
  return keys !== undefined && (!Array.isArray(keys) || keys.length > 0);
}

function reportEntry(
  atom: Atom,
  connectorAtoms: ReadonlySet<string>,
): ChatPortabilityEntry {
  switch (atom.type) {
    case "skill":
      return {
        atomId: atom.id,
        type: atom.type,
        portable: true,
        note: "Native Skill — uploadable ZIP, GA on all Chat plans (requires code execution).",
      };
    case "instruction":
    case "rule":
      return {
        atomId: atom.id,
        type: atom.type,
        portable: true,
        downgradedTo: "skill",
        note: "No ambient loader in Chat. Bridged to an on-invoke skill, and surfaced in project-instructions.md for within-Project ambient use.",
      };
    case "mcp_server": {
      const mcp = atom as McpAtom;
      if (hasCodexOnlyMcpConfig(mcp)) {
        return {
          atomId: atom.id,
          type: atom.type,
          portable: false,
          note: "Codex-only MCP policy cannot be represented safely as a Chat connector.",
        };
      }
      if (invalidChatMcpFields(mcp as unknown as Record<string, unknown>).length > 0) {
        return {
          atomId: atom.id,
          type: atom.type,
          portable: false,
          note: "MCP fields are malformed or cannot be represented by a Chat connector.",
        };
      }
      if (
        (mcp.transport === "http" || mcp.transport === "sse") &&
        !isCredentialFreeHttpUrl(mcp.url)
      ) {
        return {
          atomId: atom.id,
          type: atom.type,
          portable: false,
          note: "Remote MCP URL is not a credential-free HTTP(S) endpoint.",
        };
      }
      const transport = mcp.transport ?? "stdio";
      if (transport === "http" || transport === "sse") {
        if (!connectorAtoms.has(atom.id)) {
          return {
            atomId: atom.id,
            type: atom.type,
            portable: false,
            note: "MCP descriptor fields cannot be represented by a Chat connector.",
          };
        }
        return {
          atomId: atom.id,
          type: atom.type,
          portable: true,
          downgradedTo: "connector",
          note: "Remote MCP — add as a custom Connector (Pro+). See connectors.json.",
        };
      }
      return {
        atomId: atom.id,
        type: atom.type,
        portable: false,
        note: "stdio MCP server — Chat connectors are remote-only. Ship it as a .mcpb for Desktop/Cowork instead.",
      };
    }
    case "command":
      return {
        atomId: atom.id,
        type: atom.type,
        portable: true,
        downgradedTo: "skill",
        note: "No slash commands in Chat. Procedure compiled to an on-invoke skill.",
      };
    case "subagent":
      return {
        atomId: atom.id,
        type: atom.type,
        portable: false,
        note: "Subagents do not cross to Chat. Ship inside a plugin for Code/Cowork.",
      };
    case "hook":
      return {
        atomId: atom.id,
        type: atom.type,
        portable: false,
        note: "Hooks do not cross to Chat. Ship inside a plugin for Code/Cowork.",
      };
    case "plugin":
      return {
        atomId: atom.id,
        type: atom.type,
        portable: false,
        note: "Plugins are not installable in Chat. Use `agentpack pack plugin` for plugin-aware surfaces.",
      };
    default:
      return {
        atomId: atom.id,
        type: atom.type,
        portable: false,
        note: "No Claude Chat surface for this atom type.",
      };
  }
}

function readme(
  manifest: AgentPackManifest,
  profile: string,
  skills: ChatSkillArtifact[],
  connectors: ChatConnector[],
  report: ChatPortabilityEntry[],
): string {
  const m = manifest.metadata;
  const native = skills.filter((s) => s.kind === "native");
  const onInvoke = skills.filter((s) => s.kind === "on-invoke");
  const lines: string[] = [
    `# ${m.name} — Claude Chat install`,
    "",
    `> ${m.description}`,
    "",
    `Pack \`${m.id}\` v${m.version} · profile \`${profile}\`. Claude Chat (claude.ai) ` +
      `has no bundle format, so this directory is a set of copy-paste install steps.`,
    "",
    "## Install",
    "",
  ];

  let step = 1;
  if (native.length > 0) {
    lines.push(
      `${step++}. **Upload the skills.** In claude.ai → Settings → Skills, upload each ZIP under \`skills/\`:`,
    );
    for (const s of native)
      lines.push(`   - \`skills/${s.skillName}.zip\` (from ${s.atomId})`);
    lines.push("");
  }
  if (onInvoke.length > 0) {
    lines.push(
      `${step++}. **Upload the on-invoke guidance skills.** These bridge ambient instructions/rules/commands — they apply only when invoked, NOT on every message:`,
    );
    for (const s of onInvoke)
      lines.push(`   - \`skills/${s.skillName}.zip\` (from ${s.atomId})`);
    lines.push("");
  }
  if (connectors.length > 0) {
    lines.push(
      `${step++}. **Add the connectors.** Follow \`connectors.json\` to add each remote MCP connector (Pro+; free plan allows one). AgentPack can't auto-install these — Chat has no install API.`,
    );
    lines.push("");
  }
  lines.push(
    `${step++}. **(Optional) Ambient guidance.** Paste \`project-instructions.md\` into a claude.ai Project's custom instructions for within-Project ambient behavior.`,
    "",
    "## Portability report",
    "",
    "How each atom in this profile reaches (or doesn't reach) Claude Chat:",
    "",
    "| Atom | Type | Reaches Chat? | How |",
    "| --- | --- | --- | --- |",
  );
  for (const r of report) {
    const reaches = r.portable
      ? r.downgradedTo
        ? `yes (as ${r.downgradedTo})`
        : "yes"
      : "**not portable**";
    lines.push(`| \`${r.atomId}\` | ${r.type} | ${reaches} | ${r.note} |`);
  }
  lines.push("");
  const notPortable = report.filter((r) => !r.portable);
  if (notPortable.length > 0) {
    lines.push(
      "Atoms that are **not portable** to Chat (downgraded or dropped): " +
        notPortable.map((r) => `\`${r.atomId}\``).join(", ") +
        ".",
      "",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clampDescription(value: string): string {
  const v = value.trim();
  return v.length > SKILL_DESCRIPTION_MAX_LENGTH
    ? v.slice(0, SKILL_DESCRIPTION_MAX_LENGTH)
    : v;
}

function stripLeadingH1(body: string): string {
  return body.replace(/^#\s.*\n+/, "").trimEnd();
}

function uniqueName(raw: string, used: Set<string>): string {
  const base = normalizeSkillSlug(raw);
  let name = base;
  let i = 2;
  while (used.has(name)) {
    const suffix = `-${i++}`;
    name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

async function parseAtomYaml(
  packRoot: string,
  atom: Atom,
): Promise<Record<string, unknown> | null> {
  const raw = await readAtomFile(packRoot, atom);
  if (raw === null) return null;
  try {
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not YAML — fall through.
  }
  return null;
}

async function readRelativeFile(packRoot: string, relPath: string): Promise<string | null> {
  // Symlink-safe pack-relative read (skill prompt/companion path). Shared
  // trust boundary — see readPackRelativeFile (CWE-59).
  return readPackRelativeFile(packRoot, relPath);
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
