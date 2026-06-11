import * as readline from "node:readline";

/**
 * Thrown when a confirmation is required but stdin is not an interactive
 * terminal. Commands map this to exit code 2 (usage) — the caller forgot
 * `--yes` in a script/agent context, and the alternative behaviors are both
 * worse: blocking forever on a silent pipe, or resolving false and exiting 0
 * so the caller records success for an install that never happened.
 */
export class NonInteractiveError extends Error {
  constructor() {
    super(
      "Confirmation required but stdin is not a TTY (non-interactive session). Pass --yes to confirm, or run from an interactive terminal.",
    );
    this.name = "NonInteractiveError";
  }
}

/**
 * Yes/no prompt. Used by every Phase 2 command that mutates project state
 * (install / uninstall / rollback). Returns true only for "y" or "yes"
 * (case-insensitive). Throws NonInteractiveError when stdin is not a TTY;
 * resolves false if stdin closes without an answer (Ctrl-D).
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new NonInteractiveError();
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    let settled = false;
    rl.question(question, (answer) => {
      settled = true;
      rl.close();
      resolve(/^(y|yes)$/i.test(answer.trim()));
    });
    rl.on("close", () => {
      // EOF without an answer (Ctrl-D, pipe closed) — treat as declined so
      // the promise always settles and the process can't drain to exit 0
      // with a dangling prompt.
      if (!settled) resolve(false);
    });
  });
}
