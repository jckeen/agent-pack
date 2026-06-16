import * as fs from "node:fs/promises";
import type { Command } from "commander";
import ora from "ora";
import pc from "picocolors";
import {
  importClaudeMd,
  importCodexDir,
  writeImport,
  type ImportResult,
} from "@agentpack/core";
import { failCleanly } from "../lib/error.js";

// Mirrors `metadata.id` in packages/core/src/schema/agentpack.schema.ts —
// `publisher.slug`, exactly one publisher segment + one slug segment.
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*$/i;

const SOURCES = ["claude", "codex"] as const;
type Source = (typeof SOURCES)[number];

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
      "Compile an existing setup into an AgentPack. `--from claude` (default) reads a CLAUDE.md / AGENTS.md file (use `-` for stdin); `--from codex` reads a Codex setup directory.",
    )
    .option("--from <source>", "source format: `claude` (default) or `codex`", "claude")
    .option("--out <dir>", "output directory for the imported pack", "agentpack-imported")
    .option("--id <publisher.slug>", "pack id (required) — e.g. `acme.team-defaults`")
    .option("--name <name>", "human-readable pack name")
    .action(
      async (
        srcPath: string,
        options: { from: string; out: string; id?: string; name?: string },
      ) => {
        // Validate `--from` and `--id` BEFORE touching core, so bad usage fails
        // as a usage error (exit 2) rather than a runtime/schema error.
        const from = options.from as Source;
        if (!SOURCES.includes(from)) {
          console.error(
            pc.red(
              `✗ Invalid --from \`${options.from}\`. Must be one of: ${SOURCES.join(", ")}.`,
            ),
          );
          process.exit(2);
        }
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
          let result: ImportResult;
          if (from === "codex") {
            result = await importCodexDir(srcPath, { id, name: options.name });
          } else {
            const text = await readSource(srcPath);
            result = importClaudeMd(text, { id, name: options.name });
          }
          await writeImport(result, options.out);
          spinner.succeed(
            `Imported ${result.manifest.atoms.length} atom(s) → ${options.out}`,
          );
          for (const w of result.warnings) {
            const where = w.line > 0 ? `line ${w.line}: ` : "";
            console.log(pc.yellow(`! ${where}${w.message}`));
          }
          const counts = new Map<string, number>();
          for (const a of result.manifest.atoms) {
            counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
          }
          const summary = [...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([type, n]) => `${n} ${type}`)
            .join(", ");
          console.log(pc.dim(`  ${summary}`));
          console.log(pc.bold(`\nNext: run \`agentpack validate ${options.out}\`.`));
        } catch (err) {
          spinner.fail("Import failed.");
          failCleanly(err);
        }
      },
    );
}
