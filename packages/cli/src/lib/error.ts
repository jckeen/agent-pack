import pc from "picocolors";
import {
  ExitCode,
  UnknownProfileError,
  UnsupportedTargetError,
  exitCodeForError,
} from "@agentpack/core";
import { NonInteractiveError } from "./prompt.js";

/**
 * Render an Error from a CLI action with a clean one-liner (no Node stack
 * trace) and exit with the error's pinned exit code. Use at the top-level
 * catch in every command's `action()` body so users never see raw
 * `at /node_modules/...` frames.
 *
 * Exit-code mapping (see `Plans/PROTOCOL.md` § 5):
 *   - Usage errors (NonInteractiveError, UnknownProfileError,
 *     UnsupportedTargetError) → 2: the caller forgot `--yes` in a script/agent
 *     context, named an unknown profile, or targeted a platform the pack
 *     declares unsupported (#134).
 *   - Domain errors are mapped by `exitCodeForError`: NotFound → 8,
 *     IntegrityError → 7, Conflict → 9. This means `verify` of an uninstalled
 *     pack exits 8 and a cache integrity failure exits 7, rather than every
 *     uncaught error collapsing to a generic 1 (ISC-295).
 *   - Everything else → 1 (Generic).
 */
export function failCleanly(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(pc.red("✗ ") + msg);
  if (
    (process.env["AGENTPACK_DEBUG"] === "1" || process.env["WORKGRAPH_DEBUG"] === "1") &&
    err instanceof Error
  ) {
    console.error(pc.dim(err.stack ?? ""));
  }
  // CLI-layer usage errors exit 2 regardless of any domain mapping — a bad
  // invocation is a caller mistake, not a runtime domain failure. An
  // authored-unsupported target (#134) sits in the same family: the caller
  // asked for a target the pack explicitly refuses, like an unknown profile.
  if (
    err instanceof NonInteractiveError ||
    err instanceof UnknownProfileError ||
    err instanceof UnsupportedTargetError
  ) {
    process.exit(ExitCode.UsageError);
  }
  process.exit(exitCodeForError(err));
}
