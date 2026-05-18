import pc from "picocolors";

/**
 * Render an Error from a CLI action with a clean one-liner (no Node stack
 * trace) and exit 1. Use at the top-level catch in every command's `action()`
 * body so users never see raw `at /node_modules/...` frames.
 */
export function failCleanly(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(pc.red("✗ ") + msg);
  if (process.env["WORKGRAPH_DEBUG"] === "1" && err instanceof Error) {
    console.error(pc.dim(err.stack ?? ""));
  }
  process.exit(1);
}
