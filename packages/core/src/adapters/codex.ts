import { parse as parseYaml } from "yaml";
import type { AdapterExportOptions, AdapterOutputFile, Atom } from "../schema/types.js";
import {
  atomsByType,
  defineAdapter,
  demoteBodyHeadings,
  readAtomDirectory,
  readAtomFile,
  readPackRelativeFile,
  resolveSubagentBody,
  stableJsonStringify,
  wrapInstructionBlock,
} from "./types.js";
import { renderRuleMarkdown } from "./ruleContent.js";
import { isShellEscape } from "./commandGate.js";
import {
  conformSkillMd,
  normalizeSkillSlug,
  renderSkillMd,
} from "../skills/agentskills.js";

function tomlEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(
      /[\u0000-\u001f\u007f]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

function renderTomlValue(value: unknown): string {
  if (typeof value === "string") return `"${tomlEscape(value)}"`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `"${String(value)}"`;
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(renderTomlValue).join(", ")}]`;
  }
  // Nested objects are JSON-stringified into a TOML basic string to keep the
  // grammar simple and deterministic; consumers that want structured TOML
  // can parse the JSON. Better: don't pass nested objects through.
  return `"${tomlEscape(JSON.stringify(value))}"`;
}

function renderTomlTable(name: string, table: Record<string, unknown>): string {
  const keys = Object.keys(table).sort();
  const lines: string[] = [`[${name}]`];
  for (const k of keys) {
    const v = table[k];
    if (v === undefined) continue;
    lines.push(`${k} = ${renderTomlValue(v)}`);
  }
  return lines.join("\n") + "\n";
}

function renderTomlDocument(table: Record<string, unknown>): string {
  return (
    Object.keys(table)
      .sort()
      .filter((key) => table[key] !== undefined)
      .map((key) => `${key} = ${renderTomlValue(table[key])}`)
      .join("\n") + "\n"
  );
}

function slugFor(atom: Atom): string {
  const raw = atom.id.split(":")[1] ?? atom.name;
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export const codexAdapter = defineAdapter({
  target: "codex",
  async build(options: AdapterExportOptions) {
    const { manifest, packRoot, resolvedAtoms } = options;
    const files: AdapterOutputFile[] = [];
    const warnings: string[] = [];
    const unsupported: string[] = [];
    const byType = atomsByType(resolvedAtoms);

    // ---------- AGENTS.md ----------
    const sections: string[] = [`# ${manifest.metadata.name}\n`];
    sections.push(
      `> ${manifest.metadata.description}\n\n` +
        `Publisher: \`${manifest.metadata.publisher}\` · Version: \`${manifest.metadata.version}\` · Profile: \`${options.profile}\`\n`,
    );

    for (const atom of byType.get("instruction") ?? []) {
      const body = (await readAtomFile(packRoot, atom)) ?? atom.description;
      // Section header is `## ` (level 2). Strip a redundant leading H1 that
      // duplicates the atom name, and demote remaining headings so they nest
      // beneath the section header instead of emitting an <h1> under the <h2>
      // (issue #24).
      const text = demoteBodyHeadings(body.trim(), 2, atom.name);
      sections.push(`## ${atom.name}\n\n_(${atom.id})_\n\n${text}\n`);
    }
    const ruleAtoms = byType.get("rule") ?? [];
    if (ruleAtoms.length > 0) {
      sections.push(`## Rules\n`);
      for (const atom of ruleAtoms) {
        const body = await renderRuleMarkdown(packRoot, atom);
        sections.push(`### ${atom.name}\n\n_(${atom.id})_\n\n${body}\n`);
      }
    }
    const workflowAtoms = byType.get("workflow") ?? [];
    if (workflowAtoms.length > 0) {
      sections.push(`## Workflows\n`);
      for (const atom of workflowAtoms) {
        sections.push(`### ${atom.name}\n\n${atom.description}\n`);
      }
    }
    // Keep an AGENTS.md index in addition to the native `.agents/skills/`
    // output so users can inspect the pack's reusable procedures in one place.
    //
    // Slugs are computed ONCE here — Agent Skills spec-normalized, with
    // command/skill collisions resolved — and reused by both this index and
    // the emission loops below, so the index never points at a path that the
    // collision rename moved.
    const skillAtomsAll = byType.get("skill") ?? [];
    const commandAtomsAll = byType.get("command") ?? [];
    const emittedSkillSlug = new Map<string, string>();
    const skillSlugs = new Set<string>();
    for (const atom of skillAtomsAll) {
      const slug = normalizeSkillSlug(slugFor(atom));
      emittedSkillSlug.set(atom.id, slug);
      skillSlugs.add(slug);
    }
    const collidedCommands = new Set<string>();
    for (const atom of commandAtomsAll) {
      let slug = normalizeSkillSlug(slugFor(atom));
      if (skillSlugs.has(slug)) {
        collidedCommands.add(atom.id);
        slug = `${slug}-command`;
      }
      emittedSkillSlug.set(atom.id, slug);
    }
    if (skillAtomsAll.length + commandAtomsAll.length > 0) {
      sections.push(`## Skills\n`);
      sections.push(
        `The following reusable procedures ship with this pack under \`.agents/skills/\`. Read the referenced SKILL.md when a task matches.\n`,
      );
      for (const atom of [...skillAtomsAll, ...commandAtomsAll]) {
        const slug = emittedSkillSlug.get(atom.id) ?? normalizeSkillSlug(slugFor(atom));
        sections.push(
          `- **${atom.name}** (\`.agents/skills/${slug}/SKILL.md\`) — ${atom.description}`,
        );
      }
      sections.push("");
    }
    files.push({
      path: "AGENTS.md",
      content: wrapInstructionBlock(manifest.metadata.id, sections.join("\n")),
      action: "create",
    });

    // ---------- .codex/config.toml ----------
    const meta = {
      pack_id: manifest.metadata.id,
      pack_version: manifest.metadata.version,
      profile: options.profile,
      generated_by: "agentpack-cli",
    };
    const tomlBlocks: string[] = [
      `# Generated by AgentPack for ${manifest.metadata.id}@${manifest.metadata.version}`,
      `# Profile: ${options.profile}`,
      `# NOTE: Codex CLI (as of 0.128.0) does not read project-level .codex/config.toml —`,
      `# it loads ~/.codex/config.toml only. This file is a REFERENCE output: copy the`,
      `# mcp_servers tables into ~/.codex/config.toml to activate them.`,
      "",
      renderTomlTable("agentpack", meta),
    ];

    const mcpAtoms = byType.get("mcp_server") ?? [];
    const declaredServers = manifest.permissions?.mcp?.servers ?? [];
    for (const atom of mcpAtoms) {
      const slug = slugFor(atom);
      const a = atom as {
        transport?: string;
        command?: string;
        args?: string[];
        env?: Record<string, unknown>;
      };
      // Same gate as the claude-code adapter: MCP commands are arbitrary
      // process execution. Require declaration in permissions.mcp.servers and
      // refuse shell-escape shapes.
      const joined = [a.command ?? "", ...(a.args ?? [])].join(" ");
      if (!declaredServers.includes(slug)) {
        warnings.push(
          `MCP server \`${atom.id}\` is not declared in \`permissions.mcp.servers\`. Refusing to emit it.`,
        );
        unsupported.push(atom.id);
        continue;
      }
      if (!a.command || isShellEscape(a.command, a.args ?? [])) {
        warnings.push(
          `MCP server \`${atom.id}\` command \`${joined || "(empty)"}\` contains a shell-escape shape. Refusing to emit it.`,
        );
        unsupported.push(atom.id);
        continue;
      }
      const envKeys = Object.keys(a.env ?? {});
      tomlBlocks.push(
        renderTomlTable(`mcp_servers.${slug}`, {
          transport: a.transport ?? "stdio",
          command: a.command ?? "",
          args: a.args ?? [],
          env_vars: envKeys,
        }),
      );
      warnings.push(
        `MCP server \`${atom.id}\` configured (reference: copy into ~/.codex/config.toml). Required env: ${envKeys.join(", ") || "(none)"}.`,
      );
    }

    files.push({
      path: ".codex/config.toml",
      content: tomlBlocks.join("\n"),
      action: "create",
    });

    // ---------- .codex/hooks.json ----------
    const allowedShellCommands = manifest.permissions?.shell?.commands ?? [];
    const hookAtoms = byType.get("hook") ?? [];
    if (hookAtoms.length > 0) {
      const hooks: Record<string, unknown[]> = {};
      for (const atom of hookAtoms) {
        const parsed = await parseAtomYaml(packRoot, atom);
        const events = ((
          parsed?.["events"] as { codex?: string[]; generic?: string[] } | undefined
        )?.codex ??
          (parsed?.["events"] as { generic?: string[] } | undefined)?.generic ?? [
            "after_edit",
          ]) as string[];
        const handler =
          (parsed?.["handler"] as { command?: string } | undefined) ??
          (atom as { handler?: { command?: string } }).handler;
        const command = handler?.command ?? "";
        if (
          !command ||
          !allowedShellCommands.includes(command) ||
          isShellEscape(command, [])
        ) {
          warnings.push(
            `Hook \`${atom.id}\` command \`${command || "(empty)"}\` is not in \`permissions.shell.commands\` or contains a shell escape. Refusing to emit it.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        for (const evt of events) {
          const list = hooks[evt] ?? [];
          list.push({
            command,
            description: atom.description,
            risk_level: atom.risk_level,
            source_atom: atom.id,
          });
          hooks[evt] = list;
        }
      }
      if (Object.keys(hooks).length > 0) {
        files.push({
          path: ".codex/hooks.json",
          content: stableJsonStringify({ hooks }),
          action: "create",
        });
        warnings.push(
          "Hook atom(s) installed — `.codex/hooks.json` declares shell commands after edits.",
        );
      }
    }

    // ---------- .agents/skills ----------
    // Emitted skill folders conform to the Agent Skills spec (agentskills.io).
    for (const atom of skillAtomsAll) {
      const slug = emittedSkillSlug.get(atom.id) ?? normalizeSkillSlug(slugFor(atom));
      const entries = await readAtomDirectory(packRoot, atom);
      if (entries.length === 0) {
        warnings.push(
          `Skill \`${atom.id}\` directory not found at \`${atom.path}\`; emitting minimal SKILL.md.`,
        );
        files.push({
          path: `.agents/skills/${slug}/SKILL.md`,
          content: renderSkillMd(
            { name: slug, description: atom.description },
            `# ${atom.name}\n\n${atom.description}`,
          ),
          action: "create",
        });
      } else {
        // `skill.md` (lowercase, spec-accepted) is conformed to canonical
        // SKILL.md only when no SKILL.md exists — emitting both to the same
        // path would trip applyInstall's create-only write.
        const hasCanonical = entries.some((e) => e.relPath === "SKILL.md");
        for (const entry of entries) {
          if (
            entry.relPath === "SKILL.md" ||
            (entry.relPath === "skill.md" && !hasCanonical)
          ) {
            const conformed = conformSkillMd(entry.content, slug, {
              name: slug,
              description: atom.description,
            });
            warnings.push(...conformed.warnings.map((w) => `Skill \`${atom.id}\`: ${w}`));
            files.push({
              path: `.agents/skills/${slug}/SKILL.md`,
              content: conformed.content,
              action: "create",
            });
          } else {
            files.push({
              path: `.agents/skills/${slug}/${entry.relPath}`,
              content: entry.content,
              action: "create",
            });
          }
        }
      }
    }

    // ---------- .agents/skills (commands) ----------
    for (const atom of commandAtomsAll) {
      // A command whose slug collides with a skill would emit the same
      // SKILL.md path twice — applyInstall's create-only (`wx`) write then
      // throws on the duplicate and rolls the install back (codex re-review
      // P1-3). The colliding command was namespaced `<slug>-command` when the
      // slug map was built above.
      const slug = emittedSkillSlug.get(atom.id) ?? normalizeSkillSlug(slugFor(atom));
      if (collidedCommands.has(atom.id)) {
        warnings.push(
          `Command \`${atom.id}\` slug collides with a skill of the same name; emitting it as \`.agents/skills/${slug}/\`.`,
        );
      }
      const parsed = await parseAtomYaml(packRoot, atom);
      let body: string | null = null;
      const promptPath = parsed?.["prompt"];
      if (typeof promptPath === "string" && promptPath.length > 0) {
        body = await readSafeRelative(packRoot, promptPath);
      }
      files.push({
        path: `.agents/skills/${slug}/SKILL.md`,
        content: renderSkillMd(
          { name: slug, description: atom.description },
          `# ${atom.name}\n\n${body ?? atom.description}`,
        ),
        action: "create",
      });
    }

    // ---------- .codex/agents (subagents) ----------
    for (const atom of byType.get("subagent") ?? []) {
      const slug = slugFor(atom);
      const body = await resolveSubagentBody(packRoot, atom);
      const tomlTable = {
        name: atom.name,
        description: body.description ?? atom.description,
        developer_instructions: body.instructions,
      };
      files.push({
        path: `.codex/agents/${slug}.toml`,
        content:
          `# Conservative Codex subagent definition — verify against your Codex version.\n` +
          renderTomlDocument(tomlTable),
        action: "create",
      });
    }

    const supportedTypes = new Set([
      "instruction",
      "rule",
      "workflow",
      "skill",
      "command",
      "subagent",
      "hook",
      "mcp_server",
    ]);
    for (const r of resolvedAtoms) {
      if (!supportedTypes.has(r.atom.type)) {
        unsupported.push(r.atom.id);
        warnings.push(
          `Atom \`${r.atom.id}\` of type \`${r.atom.type}\` is not mapped by the Codex adapter.`,
        );
      }
    }

    return { files, warnings, unsupportedAtoms: unsupported };
  },
});

async function parseAtomYaml(
  packRoot: string,
  atom: Atom,
): Promise<Record<string, unknown> | null> {
  const raw = await readAtomFile(packRoot, atom);
  if (!raw) return null;
  try {
    const parsed = parseYaml(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function readSafeRelative(packRoot: string, relPath: string): Promise<string | null> {
  // Symlink-safe pack-relative read (prompt path from an atom body). Shared
  // trust boundary — see readPackRelativeFile (CWE-59).
  return readPackRelativeFile(packRoot, relPath);
}
