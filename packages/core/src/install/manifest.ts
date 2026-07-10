import * as fs from "node:fs/promises";
import { z } from "zod";
import type { TargetPlatform } from "../schema/types.js";
import type { InstallManifestV1 } from "./types.js";
import type { AgentpackPaths } from "./paths.js";
import { installManifestPath } from "./paths.js";
import { lockfileSourceSchema } from "./lockfile.js";

const TARGET_PLATFORMS_ARR: readonly TargetPlatform[] = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
] as const;

const fileRecord = z.object({
  path: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith("/"), "manifest paths must be project-relative")
    .refine((p) => !/^[A-Za-z]:[\\/]/.test(p), "manifest paths must be project-relative"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const backupRecord = z.object({
  original: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith("/"), "backups[].original must be project-relative")
    .refine(
      (p) => !/^[A-Za-z]:[\\/]/.test(p),
      "backups[].original must be project-relative",
    ),
  backupPath: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith("/"), "backups[].backupPath must be project-relative")
    .refine(
      (p) => !/^[A-Za-z]:[\\/]/.test(p),
      "backups[].backupPath must be project-relative",
    )
    // A backup is READ during rollback/update-restore and written into the
    // project. The manifest is attacker-influenced (repos ship committed
    // `.agentpack/installed/*.json`), so a `..` traversal would turn a
    // restore into an arbitrary-file-read-into-project exfiltration primitive
    // (security review, sync S2). Confine every backup to the backups dir.
    .refine(
      (p) => !p.split(/[\\/]/).includes(".."),
      "backups[].backupPath must not contain `..`",
    )
    .refine(
      (p) => p.replace(/\\/g, "/").startsWith(".agentpack/backups/"),
      "backups[].backupPath must live under .agentpack/backups/",
    ),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const installManifestSchema = z.object({
  manifestVersion: z.literal(1),
  packId: z.string().min(1),
  packVersion: z.string().min(1),
  target: z.enum(TARGET_PLATFORMS_ARR as unknown as readonly [string, ...string[]]),
  profile: z.string().min(1),
  installedAt: z.string().min(1),
  cliVersion: z.string().min(1),
  adapterVersions: z.record(z.string(), z.string()),
  created: z.array(fileRecord),
  modified: z.array(fileRecord),
  backups: z.array(backupRecord),
  atomIds: z.array(z.string()),
  merges: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .refine((p) => !p.startsWith("/"), "merges[].path must be project-relative")
          .refine(
            (p) => !/^[A-Za-z]:[\\/]/.test(p),
            "merges[].path must be project-relative",
          ),
        strategy: z.enum(["marker", "json"]),
        fragment: z.string(),
        fragmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .optional(),
  lockfileChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  rollbackable: z.boolean(),
  rollbackBlockers: z.array(z.string()).optional(),
  source: lockfileSourceSchema.optional(),
  updatedAt: z.string().min(1).optional(),
  previousPackVersion: z.string().min(1).optional(),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
});

export function serializeInstallManifest(m: InstallManifestV1): string {
  // Pretty-print with 2-space indent for diffability. Determinism does not
  // matter here (per-machine state file).
  return JSON.stringify(m, null, 2) + "\n";
}

export function parseInstallManifest(raw: string): InstallManifestV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `install manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = installManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `install manifest failed schema validation:\n${result.error.issues
        .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  return result.data as InstallManifestV1;
}

export class InstallManifestNotFoundError extends Error {
  constructor(
    public packId: string,
    public path: string,
  ) {
    super(
      `No install manifest found for pack \`${packId}\` (expected ${path}). Has it been installed?`,
    );
    this.name = "InstallManifestNotFoundError";
  }
}

export async function readInstallManifest(
  p: AgentpackPaths,
  packId: string,
): Promise<InstallManifestV1> {
  const target = installManifestPath(p, packId);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InstallManifestNotFoundError(packId, target);
    }
    throw err;
  }
  return parseInstallManifest(raw);
}

export async function writeInstallManifest(
  p: AgentpackPaths,
  manifest: InstallManifestV1,
): Promise<string> {
  const target = installManifestPath(p, manifest.packId);
  await fs.writeFile(target, serializeInstallManifest(manifest), "utf8");
  return target;
}

export async function deleteInstallManifest(
  p: AgentpackPaths,
  packId: string,
): Promise<void> {
  const target = installManifestPath(p, packId);
  try {
    await fs.unlink(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * List every install manifest under `.agentpack/installed/`. Returns
 * already-parsed manifests; surface invalid manifests as errors with the
 * filename so users can investigate.
 */
export async function listInstallManifests(
  p: AgentpackPaths,
): Promise<InstallManifestV1[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(p.installedDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: InstallManifestV1[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const raw = await fs.readFile(`${p.installedDir}/${name}`, "utf8");
    out.push(parseInstallManifest(raw));
  }
  return out;
}
