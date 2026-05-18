import * as readline from "node:readline";

/**
 * Yes/no prompt. Used by every Phase 2 command that mutates project state
 * (install / uninstall / rollback). Returns true only for "y" or "yes"
 * (case-insensitive).
 */
export async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^(y|yes)$/i.test(answer.trim()));
    });
  });
}
