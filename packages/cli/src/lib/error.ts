import pc from "picocolors";
import { UnknownProfileError } from "@agentpack/core";
import { NonInteractiveError } from "./prompt.js";

/**
 * Render an Error from a CLI action with a clean one-liner (no Node stack
 * trace) and exit non-zero. Use at the top-level catch in every command's
 * `action()` body so users never see raw `at /node_modules/...` frames.
 *
 * NonInteractiveError exits 2 (bad invocation — the caller forgot `--yes` in
 * a script/agent context); everything else exits 1.
 */
export function failCleanly(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(pc.red("✗ ") + msg);
  if (
    (process.env["AGENTPACK_DEBUG"] === "1" || (process.env["AGENTPACK_DEBUG"] === "1" || process.env["WORKGRAPH_DEBUG"] === "1")) &&
    err instanceof Error
  ) {
    console.error(pc.dim(err.stack ?? ""));
  }
  const usageError =
    err instanceof NonInteractiveError || err instanceof UnknownProfileError;
  process.exit(usageError ? 2 : 1);
}
