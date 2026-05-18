import type { AgentPackAdapter, TargetPlatform } from "../schema/types.js";
import { claudeCodeAdapter } from "./claudeCode.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { chatgptAdapter } from "./chatgpt.js";
import { genericAdapter } from "./generic.js";

export const adapters: Record<TargetPlatform, AgentPackAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  chatgpt: chatgptAdapter,
  generic: genericAdapter,
};

export function getAdapter(target: TargetPlatform): AgentPackAdapter {
  const adapter = adapters[target];
  if (!adapter) {
    throw new Error(
      `Unknown adapter target \`${target}\`. Available: ${Object.keys(adapters).join(", ")}`,
    );
  }
  return adapter;
}

export {
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  chatgptAdapter,
  genericAdapter,
};
export type { AgentPackAdapter };
