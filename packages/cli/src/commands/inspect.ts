import type { Command } from "commander";
import pc from "picocolors";
import {
  computeRisk,
  loadManifest,
  resolveAtoms,
  summarizePermissions,
  validateManifest,
  type CompatibilityStatus,
  type TargetPlatform,
} from "@agentpack/core";
import { header, renderPermissionSummary, riskBadge } from "../lib/render.js";
import { failCleanly } from "../lib/error.js";

const TARGET_ORDER: TargetPlatform[] = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
];

function statusGlyph(status: CompatibilityStatus | undefined): string {
  switch (status) {
    case "supported":
      return pc.green("✓ supported");
    case "partial":
      return pc.yellow("◐ partial");
    case "experimental":
      return pc.cyan("◌ experimental");
    case "unsupported":
      return pc.red("✗ unsupported");
    default:
      return pc.dim("  -");
  }
}

export function registerInspect(program: Command): void {
  program
    .command("inspect [path]")
    .description("Print metadata, compatibility, profiles, atoms, risk, and permissions for a pack.")
    .option("--profile <name>", "profile to use for risk and permission preview", "safe")
    .action(async (target: string | undefined, options: { profile: string }) => {
      const source = target ?? process.cwd();
      try {
        const loaded = await loadManifest(source);
        const validation = validateManifest(loaded.manifest);
        const m = loaded.manifest;

        console.log(header(`${m.metadata.name}  (${m.metadata.id})`));
        console.log(`  ${pc.dim(m.metadata.description)}`);
        console.log(
          `  version ${pc.bold(m.metadata.version)} · publisher ${pc.bold(m.metadata.publisher)}` +
            (m.metadata.license ? ` · license ${m.metadata.license}` : ""),
        );
        if (m.metadata.tags?.length) {
          console.log(`  tags: ${m.metadata.tags.map((t) => pc.dim(`#${t}`)).join(" ")}`);
        }
        console.log("");

        console.log(pc.bold("Compatibility"));
        for (const target of TARGET_ORDER) {
          const t = m.compatibility.targets[target];
          const line = `  ${target.padEnd(13)} ${statusGlyph(t?.status)}`;
          console.log(t?.notes ? `${line} ${pc.dim(`— ${t.notes}`)}` : line);
        }
        console.log("");

        console.log(pc.bold("Profiles"));
        for (const [name, spec] of Object.entries(m.profiles)) {
          console.log(`  ${pc.cyan(name)} — ${spec.description ?? ""}`);
          if (spec.include?.length) {
            for (const i of spec.include) console.log(`    + ${pc.dim(i)}`);
          }
          if (spec.exclude?.length) {
            for (const e of spec.exclude) console.log(`    - ${pc.dim(e)}`);
          }
        }
        console.log("");

        console.log(pc.bold(`Atoms (${m.atoms.length})`));
        for (const atom of m.atoms) {
          console.log(
            `  ${pc.cyan(atom.id.padEnd(34))}` +
              ` ${atom.type.padEnd(12)}` +
              ` ${riskBadge(atom.risk_level)}` +
              ` ${pc.dim(atom.description)}`,
          );
        }
        console.log("");

        if (!m.profiles[options.profile]) {
          console.log(
            pc.yellow(
              `! Profile \`${options.profile}\` is not declared. Available: ${Object.keys(m.profiles).join(", ")}`,
            ),
          );
        } else {
          const resolved = resolveAtoms({
            manifest: m,
            profile: options.profile,
          });
          const perms = summarizePermissions(m, resolved);
          const risk = computeRisk(m, resolved, perms);

          console.log(
            pc.bold(`Preview for profile \`${options.profile}\``) +
              ` — risk ${riskBadge(risk.level)}, ${resolved.length} atoms`,
          );
          console.log(renderPermissionSummary(perms));
        }
        console.log("");

        if (!validation.valid) {
          console.log(
            pc.red(
              `✗ Manifest validation failed (${validation.errors.length} error(s)). Run \`agentpack validate\` for details.`,
            ),
          );
          process.exit(1);
        } else if (validation.warnings.length > 0) {
          console.log(pc.yellow(`! ${validation.warnings.length} validation warning(s).`));
        } else {
          console.log(pc.green("✓ Manifest valid."));
        }
      } catch (err) {
        failCleanly(err);
      }
    });
}
