import type { Command } from "commander";
import pc from "picocolors";
import ora from "ora";
import {
  exportPack,
  exportPlugin,
  exportMcpb,
  exportChat,
  type PortabilityCeiling,
  type TargetPlatform,
} from "@agentpack/core";
import { renderInstallPlan } from "../lib/render.js";

const VALID_TARGETS: TargetPlatform[] = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
];

export function registerPack(program: Command): void {
  const pack = program
    .command("pack")
    .description("Pack-level operations (export, lock, etc.).");

  pack
    .command("export [path]")
    .description("Compile an AgentPack to platform-native files and write them to --out.")
    .option("--target <target>", "platform target", "claude-code")
    .option("--profile <profile>", "install profile")
    .option("--out <dir>", "output directory", "dist")
    .option("--only <atomIds>", "comma-separated subset of atom ids to include")
    .option("--no-strict", "do not abort on validation errors")
    .option(
      "--allow-missing",
      "allow exporting even when atom body files are missing (default: refuse)",
      false,
    )
    .action(
      async (
        target: string | undefined,
        options: {
          target: TargetPlatform;
          profile?: string;
          out: string;
          only?: string;
          strict?: boolean;
          allowMissing?: boolean;
        },
      ) => {
        if (!VALID_TARGETS.includes(options.target)) {
          console.error(
            pc.red(
              `Invalid --target \`${options.target}\`. Choose one of: ${VALID_TARGETS.join(", ")}`,
            ),
          );
          process.exit(2);
        }
        const source = target ?? process.cwd();
        const spinner = ora(`Exporting ${source} → ${options.target}`).start();
        try {
          const result = await exportPack({
            source,
            target: options.target,
            profile: options.profile,
            outDir: options.out,
            strict: options.strict ?? true,
            allowMissingBodies: options.allowMissing ?? false,
            onlyAtoms: options.only
              ?.split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
          spinner.succeed(
            `Wrote ${result.writtenFiles.length} file(s) to ${pc.cyan(result.outDir)}`,
          );
          console.log("");
          console.log(renderInstallPlan(result.plan));
          console.log("");
          console.log(pc.dim(`outDir: ${result.outDir}`));
        } catch (err) {
          spinner.fail(`Export failed: ${(err as Error).message}`);
          if (
            (process.env["AGENTPACK_DEBUG"] === "1" ||
              process.env["WORKGRAPH_DEBUG"] === "1") &&
            err instanceof Error
          ) {
            console.error(pc.dim(err.stack ?? ""));
          }
          process.exit(1);
        }
      },
    );

  pack
    .command("plugin [path]")
    .description(
      "Compile an AgentPack into a Claude Code plugin directory (installable via the Directory / `/plugin install`, reaching Code, Cowork, Desktop, and the web).",
    )
    .option("--profile <profile>", "install profile")
    .option("--out <dir>", "output directory", "dist-plugin")
    .option("--only <atomIds>", "comma-separated subset of atom ids to include")
    .option("--no-strict", "do not abort on validation errors")
    .option(
      "--allow-missing",
      "allow exporting even when atom body files are missing (default: refuse)",
      false,
    )
    .option(
      "--no-marketplace",
      "do not emit .claude-plugin/marketplace.json (emit only the plugin)",
    )
    .action(
      async (
        path: string | undefined,
        options: {
          profile?: string;
          out: string;
          only?: string;
          strict?: boolean;
          allowMissing?: boolean;
          marketplace?: boolean;
        },
      ) => {
        const source = path ?? process.cwd();
        const spinner = ora(`Compiling ${source} → Claude Code plugin`).start();
        try {
          const result = await exportPlugin({
            source,
            profile: options.profile,
            outDir: options.out,
            strict: options.strict ?? true,
            allowMissingBodies: options.allowMissing ?? false,
            marketplace: options.marketplace ?? true,
            onlyAtoms: options.only
              ?.split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
          spinner.succeed(
            `Wrote plugin \`${result.pluginName}\` — ${result.writtenFiles.length} file(s) to ${pc.cyan(result.outDir)}`,
          );
          console.log("");
          const labels: Record<PortabilityCeiling, string> = {
            universal: "reaches every Claude surface",
            plugin: "reaches plugin surfaces (Code, Cowork, Desktop, web Directory)",
            sdk: "Agent SDK / Managed Agents only",
            terminal: "Claude Code only (no ambient home elsewhere)",
          };
          console.log(pc.bold("Portability of bundled atoms:"));
          for (const ceiling of ["universal", "plugin", "sdk", "terminal"] as const) {
            const types = result.portability.byCeiling[ceiling];
            if (types.length > 0) {
              const bullet = ceiling === "terminal" ? pc.yellow("•") : pc.green("•");
              console.log(
                `  ${bullet} ${ceiling} — ${labels[ceiling]}: ${types.join(", ")}`,
              );
            }
          }
          if (result.portability.byCeiling.terminal.length > 0) {
            console.log(
              pc.yellow(
                `\n  ⚠ Instruction/rule guidance is bundled as an on-invoke skill (not ambient) outside Claude Code — there's no CLAUDE.md loader on Cowork/web.`,
              ),
            );
          }
          console.log("");
          console.log(
            pc.dim(
              `Install: \`/plugin marketplace add <this-repo>\` then \`/plugin install ${result.pluginName}@${result.pluginName}-marketplace\``,
            ),
          );
          console.log(pc.dim(`outDir: ${result.outDir}`));
        } catch (err) {
          spinner.fail(`Plugin export failed: ${(err as Error).message}`);
          if (
            (process.env["AGENTPACK_DEBUG"] === "1" ||
              process.env["WORKGRAPH_DEBUG"] === "1") &&
            err instanceof Error
          ) {
            console.error(pc.dim(err.stack ?? ""));
          }
          process.exit(1);
        }
      },
    );

  pack
    .command("mcpb [path]")
    .description(
      "Compile a pack's stdio mcp_server atom(s) into a `.mcpb` MCP Bundle (one-click LOCAL MCP install on Cowork and Desktop).",
    )
    .option("--profile <profile>", "install profile")
    .option("--out <dir>", "output directory", "dist-mcpb")
    .option("--only <atomIds>", "comma-separated subset of atom ids to include")
    .option("--no-strict", "do not abort on validation errors")
    .action(
      async (
        path: string | undefined,
        options: {
          profile?: string;
          out: string;
          only?: string;
          strict?: boolean;
        },
      ) => {
        const source = path ?? process.cwd();
        const spinner = ora(`Compiling ${source} → .mcpb bundle`).start();
        try {
          const result = await exportMcpb({
            source,
            profile: options.profile,
            outDir: options.out,
            strict: options.strict ?? true,
            onlyAtoms: options.only
              ?.split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
          spinner.succeed(
            `Wrote ${pc.cyan(result.bundlePath)} — server: ${result.serverNames[0]}`,
          );
          if (result.skippedServers.length > 0) {
            console.log(
              pc.yellow(
                `\n  ⚠ A .mcpb describes ONE server. Bundled the first; not included: ${result.skippedServers.join(", ")}. Split these into separate packs/bundles.`,
              ),
            );
          }
          const secrets = Object.keys(result.manifest.user_config ?? {});
          if (secrets.length > 0) {
            console.log(
              pc.dim(
                `\n  Required at install time (prompted, never baked in): ${secrets.join(", ")}`,
              ),
            );
          }
          console.log(
            pc.dim(
              `\nInstall: open the .mcpb in Claude Desktop, or upload it in Cowork's connector settings.`,
            ),
          );
        } catch (err) {
          spinner.fail(`.mcpb export failed: ${(err as Error).message}`);
          if (
            (process.env["AGENTPACK_DEBUG"] === "1" ||
              process.env["WORKGRAPH_DEBUG"] === "1") &&
            err instanceof Error
          ) {
            console.error(pc.dim(err.stack ?? ""));
          }
          process.exit(1);
        }
      },
    );

  pack
    .command("chat [path]")
    .description(
      "Compile a pack into claude.ai (Claude Chat) install artifacts: uploadable skill ZIPs, a connectors.json recipe, project-instructions.md, and an install README. Chat has no bundle format — this fans the pack into copy-paste steps.",
    )
    .option("--profile <profile>", "install profile")
    .option("--out <dir>", "output directory", "dist-chat")
    .option("--only <atomIds>", "comma-separated subset of atom ids to include")
    .option("--no-strict", "do not abort on validation errors")
    .action(
      async (
        path: string | undefined,
        options: {
          profile?: string;
          out: string;
          only?: string;
          strict?: boolean;
        },
      ) => {
        const source = path ?? process.cwd();
        const spinner = ora(`Compiling ${source} → Claude Chat artifacts`).start();
        try {
          const result = await exportChat({
            source,
            profile: options.profile,
            outDir: options.out,
            strict: options.strict ?? true,
            onlyAtoms: options.only
              ?.split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
          spinner.succeed(
            `Wrote ${result.writtenFiles.length} file(s) to ${pc.cyan(result.outDir)}`,
          );
          const native = result.skills.filter((s) => s.kind === "native");
          const onInvoke = result.skills.filter((s) => s.kind === "on-invoke");
          console.log("");
          console.log(
            pc.bold("Skills:") +
              ` ${native.length} native, ${onInvoke.length} on-invoke (bridged from instruction/rule/command).`,
          );
          if (onInvoke.length > 0) {
            console.log(
              pc.yellow(
                `  ⚠ On-invoke skills apply only when invoked — NOT ambient. There is no instruction loader in Chat.`,
              ),
            );
          }
          if (result.connectors.length > 0) {
            console.log(
              pc.bold("Connectors:") +
                ` ${result.connectors.length} remote MCP — see connectors.json (add manually; Chat has no install API).`,
            );
          }
          const notPortable = result.report.filter((r) => !r.portable);
          if (notPortable.length > 0) {
            console.log(
              pc.yellow(
                `  ⚠ Not portable to Chat: ${notPortable.map((r) => r.atomId).join(", ")} (see README.md).`,
              ),
            );
          }
          console.log("");
          console.log(pc.dim(`Install: follow ${result.outDir}/README.md`));
        } catch (err) {
          spinner.fail(`Chat export failed: ${(err as Error).message}`);
          if (
            (process.env["AGENTPACK_DEBUG"] === "1" ||
              process.env["WORKGRAPH_DEBUG"] === "1") &&
            err instanceof Error
          ) {
            console.error(pc.dim(err.stack ?? ""));
          }
          process.exit(1);
        }
      },
    );
}
