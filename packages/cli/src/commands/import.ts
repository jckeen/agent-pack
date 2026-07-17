import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createPatch } from "diff";
import type { Command } from "commander";
import ora from "ora";
import pc from "picocolors";
import {
  foldImportInto,
  importChatgptGptDir,
  importClaudeCodeDir,
  importClaudeMd,
  importCodexDir,
  loadManifest,
  writeImport,
  type FoldChange,
  type ImportResult,
  type TargetPlatform,
} from "@agentpack/core";
import { failCleanly } from "../lib/error.js";

// Mirrors `metadata.id` in packages/core/src/schema/agentpack.schema.ts —
// `publisher.slug`, exactly one publisher segment + one slug segment.
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]*\.[a-z0-9][a-z0-9._-]*$/i;

const SOURCES = ["claude", "claude-code", "codex", "chatgpt-gpt"] as const;
type Source = (typeof SOURCES)[number];

// Which TargetPlatform a fold source's content belongs to (#133): the fold
// drops the existing pack's variant for THIS target (the fresh import owns it
// now) while preserving every other runtime's variant.
const SOURCE_TARGET: Record<Source, TargetPlatform> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  "chatgpt-gpt": "chatgpt",
};

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
      "Compile an existing setup into an AgentPack. `--from claude` (default) reads a single CLAUDE.md / AGENTS.md file (use `-` for stdin); `--from claude-code` reads a whole Claude Code config directory (~/.claude or a project's .claude/ + CLAUDE.md): skills, agents, commands, hooks, and MCP servers; `--from codex` reads a Codex setup directory; `--from chatgpt-gpt` reads a human-assembled ChatGPT-GPT bundle directory (gpt.json + optional openapi.yaml + knowledge/).",
    )
    .option(
      "--from <source>",
      "source format: `claude` (default), `claude-code`, `codex`, or `chatgpt-gpt`",
      "claude",
    )
    .option("--out <dir>", "output directory for the imported pack", "agentpack-imported")
    .option("--id <publisher.slug>", "pack id (required) — e.g. `acme.team-defaults`")
    .option("--name <name>", "human-readable pack name")
    .option(
      "--into <pack-dir>",
      "fold the import into an EXISTING pack directory (sync S3): atoms/permissions/security are regenerated from the live config; metadata, profiles, exports, and adapters are preserved. Reads the pack id from <pack-dir>/AGENTPACK.yaml.",
    )
    .option(
      "--diff",
      "with --into: preview only — print what would change and exit 2 when the pack is out of sync (zero writes)",
      false,
    )
    .action(
      async (
        srcPath: string,
        options: {
          from: string;
          out: string;
          id?: string;
          name?: string;
          into?: string;
          diff: boolean;
        },
        command: Command,
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
        if (options.diff && !options.into) {
          console.error(pc.red("✗ --diff requires --into <pack-dir>."));
          process.exit(2);
        }
        if (options.into && options.id) {
          console.error(
            pc.red(
              "✗ --id conflicts with --into — the pack id is read from the existing pack's AGENTPACK.yaml.",
            ),
          );
          process.exit(2);
        }
        if (options.into && command.getOptionValueSource("out") === "cli") {
          console.error(
            pc.red("✗ --out conflicts with --into — the fold writes into <pack-dir>."),
          );
          process.exit(2);
        }
        if (options.into) {
          await runFoldInto(srcPath, from, options.into, options.diff);
          return;
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
          const result = await runImporter(srcPath, from, { id, name: options.name });
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
          if (from === "chatgpt-gpt") {
            console.log(
              pc.dim(
                "\nHuman-judgment steps before this is usable:\n" +
                  "  - Stand up the real remote MCP endpoint that fronts the Action API and set its `url` in atoms/mcp/*.yaml (the transpiled tools are SCAFFOLDING, not runnable handlers).\n" +
                  "  - Review the connector auth scheme + scopes and least-privilege the credentials.\n" +
                  "  - If you imported knowledge/, decide between a context_pack (loaded wholesale / within a Project) and a real retrieval MCP server — ChatGPT's managed RAG is not reproduced.\n" +
                  "Cannot cross at all: GPT config auto-extraction (no export API), GPT Store distribution, Apps SDK iframe widgets, managed vector-store retrieval semantics.",
              ),
            );
          }
          console.log(pc.bold(`\nNext: run \`agentpack validate ${options.out}\`.`));
          if (from === "chatgpt-gpt") {
            console.log(
              pc.bold(
                `Then: \`agentpack pack chat ${options.out}\` for the Claude Chat artifacts.`,
              ),
            );
          }
        } catch (err) {
          spinner.fail("Import failed.");
          failCleanly(err);
        }
      },
    );
}

async function runImporter(
  srcPath: string,
  from: Source,
  opts: { id: string; name?: string | undefined; version?: string | undefined },
): Promise<ImportResult> {
  if (from === "claude-code") return importClaudeCodeDir(srcPath, opts);
  if (from === "codex") return importCodexDir(srcPath, opts);
  if (from === "chatgpt-gpt") return importChatgptGptDir(srcPath, opts);
  const text = await readSource(srcPath);
  const filename = path.basename(srcPath).toLowerCase();
  const source = filename === "claude.md" ? "claude-code" : "generic";
  return importClaudeMd(text, { ...opts, source });
}

/**
 * `import --into <pack-dir> [--diff]` (sync S3, #112): re-run the importer
 * against the live config and fold the result into an existing pack. `--diff`
 * is a zero-write preview (exit 0 = in sync, 2 = out of sync); without it the
 * pack is updated in place — the user reviews and commits, so git stays the
 * consent point for content that propagates to every machine.
 */
async function runFoldInto(
  srcPath: string,
  from: Source,
  packDir: string,
  diffOnly: boolean,
): Promise<never> {
  try {
    const { manifest: existing } = await loadManifest(packDir);
    const result = await runImporter(srcPath, from, {
      id: existing.metadata.id,
      name: existing.metadata.name,
      version: existing.metadata.version,
    });
    const { changes, removalFailures } = await foldImportInto({
      result,
      existing,
      packDir,
      apply: !diffOnly,
      sourceTarget: SOURCE_TARGET[from],
    });
    for (const w of result.warnings) {
      const where = w.line > 0 ? `line ${w.line}: ` : "";
      console.log(pc.yellow(`! ${where}${w.message}`));
    }
    if (changes.length === 0) {
      console.log(pc.green(`✓ ${existing.metadata.id} is in sync with the live config.`));
      process.exit(0);
    }
    if (diffOnly) {
      console.log(
        pc.bold(`${changes.length} file(s) differ between the live config and ${packDir}:`),
      );
      printFoldChanges(changes, { withDiffs: true });
      console.log(
        pc.dim(
          `\n(--diff) Nothing was written. Apply with \`agentpack import ${srcPath} --from ${from} --into ${packDir}\`, then review and commit.`,
        ),
      );
      process.exit(2);
    }
    // A failed stale-file deletion means the pack still ships that file —
    // report per-file and exit nonzero instead of claiming a clean fold (#122).
    if (removalFailures.length > 0) {
      printFoldChanges(
        changes.filter((c) => !removalFailures.some((f) => f.path === c.path)),
        { withDiffs: false },
      );
      console.error(
        pc.red(
          `\n✗ ${removalFailures.length} stale file(s) could not be removed — the pack still contains them:`,
        ),
      );
      for (const f of removalFailures) {
        console.error(pc.red(`  ! ${f.path} — ${f.error}`));
      }
      console.error(
        pc.dim("  Fix the file permissions (or remove them manually), then re-run."),
      );
      process.exit(1);
    }
    console.log(pc.green(`✓ Folded live config into ${packDir}:`));
    printFoldChanges(changes, { withDiffs: false });
    console.log(pc.bold(`\nNext: review the changes (git diff), then commit and push.`));
    process.exit(0);
  } catch (err) {
    failCleanly(err);
  }
  throw new Error("unreachable");
}

function printFoldChanges(changes: FoldChange[], opts: { withDiffs: boolean }): void {
  for (const c of changes) {
    if (c.kind === "added") console.log(pc.green(`  + ${c.path}`));
    else if (c.kind === "removed") console.log(pc.yellow(`  - ${c.path}`));
    else console.log(pc.cyan(`  ~ ${c.path}`));
    if (opts.withDiffs && c.kind === "changed") {
      const patch = createPatch(c.path, c.before ?? "", c.after ?? "", "pack", "live");
      console.log(pc.dim(patch.replace(/^/gm, "    ")));
    }
  }
}
