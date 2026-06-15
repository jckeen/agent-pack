import * as fs from "node:fs/promises";
import type { Command } from "commander";
import ora from "ora";
import pc from "picocolors";
import { importClaudeMd, writeImport } from "@agentpack/core";
import { failCleanly } from "../lib/error.js";

// Mirrors `metadata.id` in packages/core/src/schema/agentpack.schema.ts —
// `publisher.slug`, exactly one publisher segment + one slug segment.
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*$/i;

async function readSource(p: string): Promise<string> {
  if (p === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return fs.readFile(p, "utf8");
}

export function registerImport(program: Command): void {
  program
    .command("import <path>")
    .description(
      "Compile an existing CLAUDE.md / AGENTS.md into an AgentPack (use `-` to read stdin).",
    )
    .option("--out <dir>", "output directory for the imported pack", "agentpack-imported")
    .option("--id <publisher.slug>", "pack id (required) — e.g. `acme.team-defaults`")
    .option("--name <name>", "human-readable pack name")
    .action(
      async (srcPath: string, options: { out: string; id?: string; name?: string }) => {
        // Validate `--id` BEFORE touching core, so a bad/missing id fails as a
        // usage error (exit 2) rather than a runtime/schema error.
        const id = options.id;
        if (!id) {
          console.error(
            pc.red("✗ `--id <publisher.slug>` is required (e.g. `acme.team-defaults`)."),
          );
          process.exit(2);
        }
        if (!PACK_ID_RE.test(id)) {
          console.error(
            pc.red(
              `✗ Invalid --id \`${id}\`. Must be \`publisher.slug\` (letters, digits, ._- with exactly one dot).`,
            ),
          );
          process.exit(2);
        }

        const spinner = ora({
          text: "Importing…",
          isEnabled: !process.env["NO_COLOR"],
        }).start();
        try {
          const text = await readSource(srcPath);
          const result = importClaudeMd(text, {
            id,
            name: options.name,
          });
          await writeImport(result, options.out);
          spinner.succeed(
            `Imported ${result.manifest.atoms.length} atom(s) → ${options.out}`,
          );
          for (const w of result.warnings) {
            console.log(pc.yellow(`! line ${w.line}: ${w.message}`));
          }
          const rules = result.manifest.atoms.filter((a) => a.type === "rule").length;
          const instructions = result.manifest.atoms.length - rules;
          console.log(pc.dim(`  ${instructions} instruction(s), ${rules} rule(s)`));
          console.log(pc.bold(`\nNext: run \`agentpack validate ${options.out}\`.`));
        } catch (err) {
          spinner.fail("Import failed.");
          failCleanly(err);
        }
      },
    );
}
