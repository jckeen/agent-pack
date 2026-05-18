import type {
  AdapterExportOptions,
  AdapterOutputFile,
  Atom,
} from "../schema/types.js";
import {
  atomsByType,
  defineAdapter,
  readAtomDirectory,
  readAtomFile,
  stableJsonStringify,
  wrapInstructionBlock,
} from "./types.js";

function renderInstructionBody(
  atom: Atom,
  body: string | null,
): string {
  return `### ${atom.name}\n\n_(${atom.id})_\n\n${(body ?? atom.description).trim()}\n`;
}

function renderRuleSection(atom: Atom): string {
  return `### Rule: ${atom.name}\n\n_(${atom.id})_\n\n${atom.description.trim()}\n`;
}

export const claudeCodeAdapter = defineAdapter({
  target: "claude-code",
  async build(options: AdapterExportOptions) {
    const { manifest, packRoot, resolvedAtoms } = options;
    const files: AdapterOutputFile[] = [];
    const warnings: string[] = [];
    const unsupported: string[] = [];
    const byType = atomsByType(resolvedAtoms);

    // ---------- CLAUDE.md ----------
    const instructionAtoms = byType.get("instruction") ?? [];
    const ruleAtoms = byType.get("rule") ?? [];
    const workflowAtoms = byType.get("workflow") ?? [];

    const sections: string[] = [`# ${manifest.metadata.name}\n`];
    sections.push(
      `> ${manifest.metadata.description}\n\n` +
        `Publisher: \`${manifest.metadata.publisher}\` · Version: \`${manifest.metadata.version}\` · Profile: \`${options.profile}\`\n`,
    );

    if (instructionAtoms.length > 0) {
      sections.push("## Instructions\n");
      for (const atom of instructionAtoms) {
        const body = await readAtomFile(packRoot, atom);
        sections.push(renderInstructionBody(atom, body));
      }
    }
    if (ruleAtoms.length > 0) {
      sections.push("## Rules\n");
      for (const atom of ruleAtoms) sections.push(renderRuleSection(atom));
    }
    if (workflowAtoms.length > 0) {
      sections.push("## Workflows\n");
      for (const atom of workflowAtoms) {
        sections.push(
          `### ${atom.name}\n\n_(${atom.id})_\n\n${atom.description}\n`,
        );
      }
    }

    files.push({
      path: "CLAUDE.md",
      content: wrapInstructionBlock(
        manifest.metadata.id,
        sections.join("\n"),
      ),
      action: "create",
    });

    // ---------- Skills ----------
    const skillAtoms = byType.get("skill") ?? [];
    for (const atom of skillAtoms) {
      const slug = atom.id.split(":")[1] ?? atom.name;
      const entries = await readAtomDirectory(packRoot, atom);
      if (entries.length === 0) {
        warnings.push(
          `Skill \`${atom.id}\` directory not found at \`${atom.path}\`; emitting minimal SKILL.md.`,
        );
        files.push({
          path: `.claude/skills/${slug}/SKILL.md`,
          content: `---\nname: ${slug}\ndescription: ${atom.description}\n---\n\n# ${atom.name}\n\n${atom.description}\n`,
          action: "create",
        });
      } else {
        for (const entry of entries) {
          files.push({
            path: `.claude/skills/${slug}/${entry.relPath}`,
            content: entry.content,
            action: "create",
          });
        }
      }
    }

    // ---------- Commands (compile to skill-style folders) ----------
    const commandAtoms = byType.get("command") ?? [];
    for (const atom of commandAtoms) {
      const slug = atom.id.split(":")[1] ?? atom.name;
      const invocation = (atom as { invocation?: { slash?: string; cli?: string } })
        .invocation;
      const promptPath =
        (atom as { path: string }).path && atom.path.endsWith(".md")
          ? atom.path
          : undefined;
      let body = promptPath ? await readAtomFile(packRoot, atom) : null;
      if (!body) {
        // Try to find a prompt file referenced by the command yaml.
        const promptFromYaml = await findCommandPrompt(packRoot, atom);
        if (promptFromYaml) body = promptFromYaml;
      }
      const header = `---\nname: ${slug}\ndescription: ${atom.description}\n---\n\n`;
      const slash = invocation?.slash ? `Invocation: \`${invocation.slash}\`\n\n` : "";
      files.push({
        path: `.claude/skills/${slug}/SKILL.md`,
        content: `${header}# ${atom.name}\n\n${slash}${body ?? atom.description}\n`,
        action: "create",
      });
    }

    // ---------- Subagents ----------
    const subagentAtoms = byType.get("subagent") ?? [];
    for (const atom of subagentAtoms) {
      const slug = atom.id.split(":")[1] ?? atom.name;
      const raw = await readAtomFile(packRoot, atom);
      const instructions = extractFieldFromYaml(raw, "instructions") ?? atom.description;
      files.push({
        path: `.claude/agents/${slug}.md`,
        content:
          `---\nname: ${slug}\ndescription: ${atom.description}\nrisk_level: ${atom.risk_level}\n---\n\n# ${atom.name}\n\n${instructions}\n`,
        action: "create",
      });
    }

    // ---------- settings.json (hooks + MCP servers) ----------
    const hookAtoms = byType.get("hook") ?? [];
    const mcpAtoms = byType.get("mcp_server") ?? [];
    if (hookAtoms.length > 0 || mcpAtoms.length > 0) {
      const settings: Record<string, unknown> = {};
      if (hookAtoms.length > 0) {
        const hooks: Record<string, unknown[]> = {};
        for (const atom of hookAtoms) {
          const events =
            (atom as { lifecycle?: { events?: { "claude-code"?: string[] } } })
              .lifecycle?.events?.["claude-code"] ?? ["PostToolUse"];
          for (const evt of events) {
            const list = hooks[evt] ?? [];
            list.push({
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: atomShellCommand(atom),
                  description: atom.description,
                  // Surface risk in settings so users see it on inspection.
                  risk_level: atom.risk_level,
                  source_atom: atom.id,
                },
              ],
            });
            hooks[evt] = list;
          }
        }
        settings.hooks = hooks;
        warnings.push(
          "Hook atom(s) installed — they run shell commands after agent edits. Review before enabling.",
        );
      }
      if (mcpAtoms.length > 0) {
        const mcpServers: Record<string, unknown> = {};
        for (const atom of mcpAtoms) {
          const slug = atom.id.split(":")[1] ?? atom.name;
          const a = atom as {
            transport?: string;
            command?: string;
            args?: string[];
            env?: Record<string, unknown>;
            url?: string;
          };
          mcpServers[slug] = {
            transport: a.transport ?? "stdio",
            command: a.command,
            args: a.args ?? [],
            env: Object.fromEntries(
              Object.entries(a.env ?? {}).map(([k]) => [k, `\${${k}}`]),
            ),
            url: a.url,
            description: atom.description,
            risk_level: atom.risk_level,
            source_atom: atom.id,
          };
          warnings.push(
            `MCP server \`${atom.id}\` configured. Required env: ${Object.keys(a.env ?? {}).join(", ") || "(none)"}.`,
          );
        }
        settings.mcpServers = mcpServers;
      }
      files.push({
        path: ".claude/settings.json",
        content: stableJsonStringify(settings),
        action: "create",
      });
    }

    // Unsupported / informational
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
          `Atom \`${r.atom.id}\` of type \`${r.atom.type}\` has no Claude Code adapter mapping; emitted as note only.`,
        );
      }
    }

    return { files, warnings, unsupportedAtoms: unsupported };
  },
});

function atomShellCommand(atom: Atom): string {
  // Best-effort: read the `handler.command` from the atom YAML body. We
  // already attempted to read the file in readAtomFile, but here we fall
  // back to atom.description if nothing else available.
  return (atom as { handler?: { command?: string } }).handler?.command ?? "echo 'noop'";
}

function extractFieldFromYaml(raw: string | null, field: string): string | null {
  if (!raw) return null;
  // Tiny YAML field-extractor for `field: |\n  ...` blocks. Adapter outputs
  // can use this without pulling in the YAML parser at every atom read.
  const headerRegex = new RegExp(`^${field}:\\s*\\|\\s*\\n`, "m");
  const match = headerRegex.exec(raw);
  if (match) {
    const start = match.index + match[0].length;
    const lines = raw.slice(start).split("\n");
    const body: string[] = [];
    let indent: number | null = null;
    for (const line of lines) {
      if (line.trim() === "") {
        body.push("");
        continue;
      }
      const lineIndent = line.match(/^( +)/)?.[1]?.length ?? 0;
      if (indent === null) indent = lineIndent;
      if (lineIndent < (indent ?? 0)) break;
      body.push(line.slice(indent ?? 0));
    }
    return body.join("\n").trim();
  }
  const inline = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(raw);
  if (inline) return inline[1]!.trim().replace(/^['"]|['"]$/g, "");
  return null;
}

async function findCommandPrompt(
  packRoot: string,
  atom: Atom,
): Promise<string | null> {
  const raw = await readAtomFile(packRoot, atom);
  if (!raw) return null;
  const promptPath = /^prompt:\s*(.+)$/m.exec(raw)?.[1]?.trim();
  if (!promptPath) return null;
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  try {
    return await readFile(path.resolve(packRoot, promptPath), "utf8");
  } catch {
    return null;
  }
}
