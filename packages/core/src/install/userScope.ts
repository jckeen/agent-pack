/**
 * User-scope (sync S3 #112, extended to Codex + generic/Antigravity in #132):
 * which targets support `--scope user`, where each roots its install, and how
 * adapter output remaps into that root.
 *
 * Every user-scope install stays single-rooted: files, state
 * (`<root>/.agentpack/`), and `<root>/AGENTPACK.lock` all live under the
 * runtime's own user config directory, so verify/uninstall/update work
 * unchanged with projectRoot = the user root.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { TargetPlatform } from "../schema/types.js";
import { mapClaudeCodeOutputToUserScope } from "../adapters/claudeCode.js";
import { mapCodexOutputToUserScope } from "../adapters/codex.js";
import { mapGenericOutputToUserScope } from "../adapters/generic.js";

/**
 * User root per target, relative to `$HOME`:
 *  - claude-code → `~/.claude` (Claude Code's user config dir)
 *  - codex       → `~/.codex` (Codex's user config dir; the codex importer
 *    reads this same home-style layout back)
 *  - generic     → `~/.gemini/config` — Antigravity's global customization
 *    root ("Global Discovery", verified against agy 1.1.3), the generic
 *    target's verified user-scope consumer. Other AGENTS.md runtimes read
 *    project layouts; none is known to define a user-level root for generic
 *    output, so this is documented as the Antigravity profile.
 */
const USER_SCOPE_ROOT_SEGMENTS: Partial<Record<TargetPlatform, string[]>> = {
  "claude-code": [".claude"],
  codex: [".codex"],
  generic: [".gemini", "config"],
};

/** Targets that support `install/update/uninstall --scope user`. */
export const USER_SCOPE_TARGETS = Object.keys(USER_SCOPE_ROOT_SEGMENTS) as TargetPlatform[];

/**
 * Absolute user-scope root for a target, or null when the target has no
 * user-scope mapping.
 */
export function userScopeRoot(target: TargetPlatform): string | null {
  const segments = USER_SCOPE_ROOT_SEGMENTS[target];
  if (!segments) return null;
  return path.join(os.homedir(), ...segments);
}

/**
 * Every known user-scope root (deduped, absolute). `update --scope user` and
 * `uninstall --scope user` scan these for installed state — the per-pack
 * mapping itself always comes from each install manifest's recorded scope.
 */
export function allUserScopeRoots(): string[] {
  return [...new Set(USER_SCOPE_TARGETS.map((t) => userScopeRoot(t)!))];
}

/**
 * Remap one adapter output file from the project layout to the target's
 * user layout. Only `path`/`content` are produced — the caller mutates the
 * staged file in place so flags stamped by the adapter (e.g. `execCapable`)
 * ride through the remap.
 */
export function mapOutputToUserScope(
  target: TargetPlatform,
  file: { path: string; content: string },
): { path: string; content: string } {
  switch (target) {
    case "claude-code":
      return mapClaudeCodeOutputToUserScope(file);
    case "codex":
      return mapCodexOutputToUserScope(file);
    case "generic":
      return mapGenericOutputToUserScope(file);
    default:
      throw new Error(
        `--scope user is not supported for target \`${target}\` (supported: ${USER_SCOPE_TARGETS.join(", ")}).`,
      );
  }
}
