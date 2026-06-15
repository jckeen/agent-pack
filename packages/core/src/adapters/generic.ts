import type { AdapterExportOptions, AdapterOutputFile } from "../schema/types.js";
import {
  atomsByType,
  defineAdapter,
  demoteBodyHeadings,
  readAtomDirectory,
  readAtomFile,
  stableJsonStringify,
  wrapInstructionBlock,
} from "./types.js";
import { renderRuleMarkdown } from "./ruleContent.js";
import {
  conformSkillMd,
  normalizeSkillSlug,
  renderSkillMd,
} from "../skills/agentskills.js";

export const genericAdapter = defineAdapter({
  target: "generic",
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
      // Strip a redundant leading H1 and demote remaining headings beneath the
      // `## ` section header (issue #24).
      const text = demoteBodyHeadings(body.trim(), 2, atom.name);
      sections.push(`## ${atom.name}\n\n_(${atom.id})_\n\n${text}\n`);
    }
    for (const atom of byType.get("rule") ?? []) {
      const body = await renderRuleMarkdown(packRoot, atom);
      sections.push(`## Rule: ${atom.name}\n\n${body}\n`);
    }
    files.push({
      path: "AGENTS.md",
      content: wrapInstructionBlock(manifest.metadata.id, sections.join("\n")),
      action: "create",
    });

    // ---------- skills/ ----------
    // Emitted skill folders conform to the Agent Skills spec (agentskills.io).
    for (const atom of byType.get("skill") ?? []) {
      const slug = normalizeSkillSlug(atom.id.split(":")[1] ?? atom.name);
      const entries = await readAtomDirectory(packRoot, atom);
      if (entries.length === 0) {
        files.push({
          path: `skills/${slug}/SKILL.md`,
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
              path: `skills/${slug}/SKILL.md`,
              content: conformed.content,
              action: "create",
            });
          } else {
            files.push({
              path: `skills/${slug}/${entry.relPath}`,
              content: entry.content,
              action: "create",
            });
          }
        }
      }
    }

    // ---------- README-agent.md ----------
    const readmeLines: string[] = [
      `# Agent Instructions: ${manifest.metadata.name}\n`,
      `Generated from AgentPack \`${manifest.metadata.id}\` (version ${manifest.metadata.version}, profile ${options.profile}).\n`,
      "## Atoms",
    ];
    for (const r of resolvedAtoms) {
      readmeLines.push(
        `- **${r.atom.id}** (${r.atom.type}, risk: ${r.atom.risk_level}) — ${r.atom.description}`,
      );
    }
    const commandAtoms = byType.get("command") ?? [];
    if (commandAtoms.length > 0) {
      readmeLines.push("\n## Commands\n");
      for (const atom of commandAtoms) {
        const inv = (atom as { invocation?: { slash?: string; cli?: string } }).invocation;
        readmeLines.push(
          `- \`${inv?.slash ?? inv?.cli ?? atom.name}\` — ${atom.description}`,
        );
      }
    }
    const subagentAtoms = byType.get("subagent") ?? [];
    if (subagentAtoms.length > 0) {
      readmeLines.push("\n## Subagents\n");
      for (const atom of subagentAtoms) {
        readmeLines.push(`- **${atom.name}** — ${atom.description}`);
      }
    }
    const workflowAtoms = byType.get("workflow") ?? [];
    if (workflowAtoms.length > 0) {
      readmeLines.push("\n## Workflows\n");
      for (const atom of workflowAtoms) {
        readmeLines.push(`- **${atom.name}** — ${atom.description}`);
      }
    }
    files.push({
      path: "README-agent.md",
      content: readmeLines.join("\n") + "\n",
      action: "create",
    });

    // ---------- agentpack.json ----------
    const agentpackJson = {
      pack_id: manifest.metadata.id,
      pack_version: manifest.metadata.version,
      profile: options.profile,
      atoms: resolvedAtoms.map((r) => ({
        id: r.atom.id,
        type: r.atom.type,
        name: r.atom.name,
        description: r.atom.description,
        risk_level: r.atom.risk_level,
        permissions: r.atom.permissions ?? [],
      })),
      compatibility: manifest.compatibility,
      metadata: manifest.metadata,
      hooks_warning:
        (byType.get("hook")?.length ?? 0) > 0
          ? "This pack includes hook atoms; the generic adapter does not execute them. Implement hooks in your runtime if needed."
          : null,
      mcp_servers_warning:
        (byType.get("mcp_server")?.length ?? 0) > 0
          ? "This pack includes MCP servers; configure them in your client manually."
          : null,
    };
    files.push({
      path: "agentpack.json",
      content: stableJsonStringify(agentpackJson),
      action: "create",
    });

    if ((byType.get("hook")?.length ?? 0) > 0) {
      warnings.push(
        "Hooks present in generic export — represented as metadata in `agentpack.json`, not executed.",
      );
    }
    if ((byType.get("mcp_server")?.length ?? 0) > 0) {
      warnings.push(
        "MCP servers present in generic export — listed in `agentpack.json` only.",
      );
    }

    return { files, warnings, unsupportedAtoms: unsupported };
  },
});
