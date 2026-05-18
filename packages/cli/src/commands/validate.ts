import type { Command } from "commander";
import pc from "picocolors";
import { loadManifest, validateManifest } from "@workgraph/core";
import { renderValidation } from "../lib/render.js";

export function registerValidate(program: Command): void {
  program
    .command("validate [path]")
    .description("Validate an AgentPack manifest at the given path (default: current directory).")
    .action(async (target: string | undefined) => {
      const source = target ?? process.cwd();
      const loaded = await loadManifest(source);
      const result = validateManifest(loaded.manifest);
      console.log(pc.dim(`manifest: ${loaded.manifestPath}`));
      console.log(renderValidation(result));
      if (!result.valid) process.exit(1);
    });
}
