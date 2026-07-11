import type {
  CompatibilityMap,
  CompatibilityStatus,
  TargetPlatform,
} from "../schema/types.js";
import { TARGET_PLATFORMS } from "../schema/types.js";

const DISPLAY_NAME: Record<TargetPlatform, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  chatgpt: "ChatGPT",
  generic: "generic Agent Skills",
};

/**
 * An importer proves fidelity only for the runtime it read. Other adapters can
 * compile the atoms, but compilation alone does not prove equivalent behavior.
 */
export function importedCompatibility(
  source: TargetPlatform,
  sourceStatus: CompatibilityStatus = "supported",
): CompatibilityMap {
  const targets: CompatibilityMap = {};
  for (const target of TARGET_PLATFORMS) {
    targets[target] =
      target === source
        ? {
            status: sourceStatus,
            notes:
              sourceStatus === "supported"
                ? `Imported natively from ${DISPLAY_NAME[source]}.`
                : `Imported from ${DISPLAY_NAME[source]}; source features still require manual verification.`,
          }
        : {
            status: "partial",
            notes: `Compiled from ${DISPLAY_NAME[source]}; verify target-specific behavior after export.`,
          };
  }
  return targets;
}
