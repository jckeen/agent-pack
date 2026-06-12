import type { Command } from "commander";
import pc from "picocolors";
import { loadManifest, validateManifest, validateSkillAtoms } from "@agentpack/core";
import { renderValidation } from "../lib/render.js";
import { failCleanly } from "../lib/error.js";

export function registerValidate(program: Command): void {
  program
    .command("validate [path]")
    .description(
      "Validate an AgentPack manifest at the given path (default: current directory).",
    )
    .action(async (target: string | undefined) => {
      const source = target ?? process.cwd();
      try {
        const loaded = await loadManifest(source);
        const result = validateManifest(loaded.manifest);
        // Ingestion-side Agent Skills spec check: skill atoms may wrap any
        // spec-conformant skill folder; non-conformant sources surface as
        // warnings (the emit path auto-conforms the output).
        if (result.valid) {
          result.warnings.push(
            ...(await validateSkillAtoms(loaded.packRoot, loaded.manifest)),
          );
        }
        console.log(pc.dim(`manifest: ${loaded.manifestPath}`));
        console.log(renderValidation(result));
        if (!result.valid) process.exit(1);
      } catch (err) {
        failCleanly(err);
      }
    });
}
