import type {
  AdapterExportOptions,
  AdapterOutputFile,
  Atom,
} from "../schema/types.js";
import {
  atomsByType,
  defineAdapter,
  readAtomFile,
  stableJsonStringify,
  wrapInstructionBlock,
} from "./types.js";

function renderRuleMdc(atom: Atom): string {
  const scope = (atom as { scope?: { file_globs?: string[] } }).scope;
  const globs = scope?.file_globs ?? ["**/*"];
  const globsBlock = globs.map((g) => `  - "${g}"`).join("\n");
  return (
    `---\n` +
    `description: ${atom.description}\n` +
    `globs:\n${globsBlock}\n` +
    `alwaysApply: false\n` +
    `---\n\n` +
    `# ${atom.name}\n\n${atom.description}\n`
  );
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
    files.push({
      path: "AGENTS.md",
      content: wrapInstructionBlock(manifest.metadata.id, sections.join("\n")),
      action: "create",
    });

    // ---------- .cursor/rules/*.mdc ----------
    for (const atom of byType.get("rule") ?? []) {
      const slug = atom.id.split(":")[1] ?? atom.name;
      files.push({
        path: `.cursor/rules/${slug}.mdc`,
        content: renderRuleMdc(atom),
        action: "create",
      });
    }

    // ---------- .cursor/mcp.json ----------
    const mcpAtoms = byType.get("mcp_server") ?? [];
    if (mcpAtoms.length > 0) {
      const mcpServers: Record<string, unknown> = {};
      for (const atom of mcpAtoms) {
        const slug = atom.id.split(":")[1] ?? atom.name;
        const a = atom as {
          command?: string;
          args?: string[];
          env?: Record<string, unknown>;
          url?: string;
        };
        const envKeys = Object.keys(a.env ?? {});
        mcpServers[slug] = {
          command: a.command,
          args: a.args ?? [],
          env: Object.fromEntries(envKeys.map((k) => [k, `\${${k}}`])),
          url: a.url,
        };
        warnings.push(
          `Cursor MCP server \`${atom.id}\` requires env: ${envKeys.join(", ") || "(none)"}.`,
        );
      }
      files.push({
        path: ".cursor/mcp.json",
        content: stableJsonStringify({ mcpServers }),
        action: "create",
      });
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
        `Command atom \`${atom.id}\` — Cursor adapter emits this as a rule note rather than a registered command.`,
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
