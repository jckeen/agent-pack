import type { AdapterExportOptions, AdapterOutputFile, Atom } from "../schema/types.js";
import {
  atomsByType,
  defineAdapter,
  readAtomDirectory,
  readAtomFile,
  stableJsonStringify,
  wrapInstructionBlock,
  yamlFrontmatter,
} from "./types.js";
import { renderRuleMarkdown } from "./ruleContent.js";
import { isShellEscape } from "./commandGate.js";

function renderRuleMdc(atom: Atom, body: string): string {
  const scope = (atom as { scope?: { file_globs?: string[] } }).scope;
  const globs = scope?.file_globs ?? ["**/*"];
  return `${yamlFrontmatter({ description: atom.description, globs, alwaysApply: false })}\n# ${atom.name}\n\n${body}\n`;
}

export const cursorAdapter = defineAdapter({
  target: "cursor",
  async build(options: AdapterExportOptions) {
    const { manifest, packRoot, resolvedAtoms } = options;
    const files: AdapterOutputFile[] = [];
    const warnings: string[] = [];
    const unsupported: string[] = [];
    const byType = atomsByType(resolvedAtoms);

    // ---------- AGENTS.md (Cursor reads AGENTS.md too) ----------
    const sections: string[] = [`# ${manifest.metadata.name}\n`];
    sections.push(
      `> ${manifest.metadata.description}\n\n` +
        `Publisher: \`${manifest.metadata.publisher}\` · Version: \`${manifest.metadata.version}\` · Profile: \`${options.profile}\`\n`,
    );
    for (const atom of byType.get("instruction") ?? []) {
      const body = (await readAtomFile(packRoot, atom)) ?? atom.description;
      sections.push(`## ${atom.name}\n\n_(${atom.id})_\n\n${body.trim()}\n`);
    }
    // Cursor has no native skill/command/subagent surface — their content
    // must land in AGENTS.md or it is lost. Skill bodies are inlined; the
    // warnings below tell the author this happened.
    const skillAtoms = byType.get("skill") ?? [];
    for (const atom of skillAtoms) {
      const entries = await readAtomDirectory(packRoot, atom);
      const skillMd = entries.find((e) => e.relPath === "SKILL.md");
      const body = skillMd
        ? skillMd.content.replace(/^---[\s\S]*?---\s*/, "").trim()
        : atom.description;
      sections.push(`## Skill: ${atom.name}\n\n_(${atom.id})_\n\n${body}\n`);
    }
    for (const atom of byType.get("command") ?? []) {
      sections.push(`## Command: ${atom.name}\n\n_(${atom.id})_\n\n${atom.description}\n`);
    }
    for (const atom of byType.get("subagent") ?? []) {
      sections.push(
        `## Subagent role: ${atom.name}\n\n_(${atom.id})_\n\n${atom.description}\n`,
      );
    }
    files.push({
      path: "AGENTS.md",
      content: wrapInstructionBlock(manifest.metadata.id, sections.join("\n")),
      action: "create",
    });

    // ---------- .cursor/rules/*.mdc ----------
    for (const atom of byType.get("rule") ?? []) {
      const slug = atom.id.split(":")[1] ?? atom.name;
      const body = await renderRuleMarkdown(packRoot, atom);
      files.push({
        path: `.cursor/rules/${slug}.mdc`,
        content: renderRuleMdc(atom, body),
        action: "create",
      });
    }

    // ---------- .cursor/mcp.json ----------
    const mcpAtoms = byType.get("mcp_server") ?? [];
    if (mcpAtoms.length > 0) {
      const mcpServers: Record<string, unknown> = {};
      const declaredServers = manifest.permissions?.mcp?.servers ?? [];
      for (const atom of mcpAtoms) {
        const slug = atom.id.split(":")[1] ?? atom.name;
        const a = atom as {
          command?: string;
          args?: string[];
          env?: Record<string, unknown>;
          url?: string;
        };
        // Same gate as the claude-code adapter: MCP commands are arbitrary
        // process execution. Require declaration in permissions.mcp.servers
        // and refuse shell-escape shapes.
        const joined = [a.command ?? "", ...(a.args ?? [])].join(" ");
        if (!declaredServers.includes(slug)) {
          warnings.push(
            `MCP server \`${atom.id}\` is not declared in \`permissions.mcp.servers\`. Refusing to emit it into .cursor/mcp.json.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        if (!a.command || isShellEscape(a.command, a.args ?? [])) {
          warnings.push(
            `MCP server \`${atom.id}\` command \`${joined || "(empty)"}\` contains a shell-escape shape. Refusing to emit it into .cursor/mcp.json.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        const envKeys = Object.keys(a.env ?? {});
        mcpServers[slug] = {
          command: a.command,
          args: a.args ?? [],
          env: Object.fromEntries(envKeys.map((k) => [k, `\${${k}}`])),
        };
        warnings.push(
          `Cursor MCP server \`${atom.id}\` requires env: ${envKeys.join(", ") || "(none)"}.`,
        );
      }
      if (Object.keys(mcpServers).length > 0) {
        files.push({
          path: ".cursor/mcp.json",
          content: stableJsonStringify({ mcpServers }),
          action: "create",
        });
      }
    }

    // Hooks: no stable Cursor target → warning only
    for (const atom of byType.get("hook") ?? []) {
      warnings.push(
        `Hook atom \`${atom.id}\` — no stable Cursor hook target; not emitted.`,
      );
      unsupported.push(atom.id);
    }
    // Subagents and commands: emit as instruction notes
    for (const atom of byType.get("subagent") ?? []) {
      warnings.push(
        `Subagent atom \`${atom.id}\` — no stable Cursor subagent target; surfaced in AGENTS.md only.`,
      );
    }
    for (const atom of byType.get("skill") ?? []) {
      warnings.push(
        `Skill atom \`${atom.id}\` — Cursor has no Skills format; surfaced in AGENTS.md only.`,
      );
    }
    for (const atom of byType.get("command") ?? []) {
      warnings.push(
        `Command atom \`${atom.id}\` — Cursor has no registered-command surface; surfaced in AGENTS.md only.`,
      );
    }

    const supportedTypes = new Set([
      "instruction",
      "rule",
      "mcp_server",
      "workflow",
      "skill",
      "command",
      "subagent",
      "hook",
    ]);
    for (const r of resolvedAtoms) {
      if (!supportedTypes.has(r.atom.type)) {
        unsupported.push(r.atom.id);
        warnings.push(
          `Atom \`${r.atom.id}\` of type \`${r.atom.type}\` not mapped by the Cursor adapter.`,
        );
      }
    }

    return { files, warnings, unsupportedAtoms: unsupported };
  },
});
