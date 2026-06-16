import { z } from "zod";
import type {
  AdapterOutputFile,
  AtomType,
  ProfileName,
  TargetPlatform,
} from "../schema/types.js";
import type { LockfileV1, LockfileAtomEntry, LockfileFileEntry } from "./types.js";
import { CANONICALIZATION } from "./types.js";
import { canonicalJson, sha256Hex, sortByPath } from "./checksum.js";

const ATOM_TYPES_ARR = [
  "instruction",
  "rule",
  "skill",
  "hook",
  "command",
  "subagent",
  "mcp_server",
  "plugin",
  "workflow",
  "context_pack",
  "template",
  "eval",
] as const satisfies readonly AtomType[];

const TARGET_PLATFORMS_ARR = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
] as const satisfies readonly TargetPlatform[];

const fileEntrySchema = z.object({
  path: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith("/"), "lockfile paths must be project-relative")
    .refine((p) => !/^[A-Za-z]:[\\/]/.test(p), "lockfile paths must be project-relative"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  action: z.enum(["create", "modify"]),
});

const atomEntrySchema = z.object({
  id: z.string().min(1),
  type: z.enum(ATOM_TYPES_ARR),
  sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  contentChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  outputs: z.array(fileEntrySchema),
});

export const lockfileSchema = z.object({
  lockfileVersion: z.literal(1),
  packId: z.string().min(1),
  packVersion: z.string().min(1),
  target: z.enum(TARGET_PLATFORMS_ARR),
  profile: z.string().min(1),
  generator: z.object({ cli: z.string().min(1), adapter: z.string().min(1) }),
  manifestChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  canonicalization: z.object({
    algorithm: z.literal("sha256"),
    encoding: z.literal("utf-8"),
    lineEndings: z.literal("lf"),
  }),
  atoms: z.array(atomEntrySchema),
  dependencies: z.array(
    z.object({
      packId: z.string(),
      version: z.string(),
      resolvedChecksum: z.string(),
    }),
  ),
  signatures: z.object({
    manifest: z.string().optional(),
    provenance: z.string().optional(),
  }),
});

export interface BuildLockfileInput {
  packId: string;
  packVersion: string;
  target: TargetPlatform;
  profile: ProfileName;
  generator: { cli: string; adapter: string };
  manifestRawBytes: string;
  /** Resolved atoms (id → output files of that atom). */
  atomOutputs: Array<{
    atomId: string;
    atomType: AtomType;
    sourceBytes: string;
    files: AdapterOutputFile[];
    /** sha256 of every file (precomputed so test code can share). */
    fileHashes: Array<{
      path: string;
      sha256: string;
      bytes: number;
      action: "create" | "modify";
    }>;
  }>;
  /**
   * Optional base64-encoded signed-manifest envelope to persist into
   * `signatures.manifest`. Set by `install --require-sig` after a signature
   * verifies, so a later `verify --sig` doesn't falsely report unsigned (#35
   * fix 3). Omitted on unsigned installs — `signatures` stays `{}`.
   */
  signatureManifestB64?: string;
}

/**
 * Build a deterministic LockfileV1 from the install plan output. No timestamps,
 * no per-machine values, no absolute paths. Two clean installs of the same
 * pack/profile/target with the same CLI version produce byte-identical
 * lockfiles.
 */
export function buildLockfile(input: BuildLockfileInput): LockfileV1 {
  const manifestChecksum = sha256Hex(input.manifestRawBytes);

  const atoms: LockfileAtomEntry[] = input.atomOutputs.map((entry) => {
    const outputs: LockfileFileEntry[] = sortByPath(entry.fileHashes);
    // contentChecksum = sha256(canonicalJson(outputs)) — captures every file
    // and its hash in a stable form.
    const contentChecksum = sha256Hex(canonicalJson(outputs));
    return {
      id: entry.atomId,
      type: entry.atomType,
      sourceChecksum: sha256Hex(entry.sourceBytes),
      contentChecksum,
      outputs,
    };
  });

  // Sort atoms by id so reordering atom declaration in the manifest doesn't
  // change the lockfile bytes.
  atoms.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    lockfileVersion: 1,
    packId: input.packId,
    packVersion: input.packVersion,
    target: input.target,
    profile: input.profile,
    generator: { ...input.generator },
    manifestChecksum,
    canonicalization: { ...CANONICALIZATION },
    atoms,
    dependencies: [],
    signatures: input.signatureManifestB64 ? { manifest: input.signatureManifestB64 } : {},
  };
}

/**
 * Serialize a lockfile to canonical bytes — the form written to disk. Uses
 * canonical JSON (sorted keys) but pretty-printed with 2-space indent for
 * human-diffability. The pretty-print does NOT affect determinism: same input
 * always produces the same output.
 */
export function serializeLockfile(lock: LockfileV1): string {
  // We pretty-print for human readability, but use canonicalJson semantics
  // (sorted keys) by round-tripping through it.
  const canonical = canonicalJson(lock);
  const parsed = JSON.parse(canonical) as unknown;
  return JSON.stringify(parsed, sortedReplacer, 2) + "\n";
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = (value as Record<string, unknown>)[k];
  }
  return out;
}

export function parseLockfile(raw: string): LockfileV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `AGENTPACK.lock is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = lockfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `AGENTPACK.lock failed schema validation:\n${result.error.issues
        .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  return result.data as LockfileV1;
}

/**
 * sha256 of the lockfile bytes as they're written to disk. Used by install
 * manifest's `lockfileChecksum` cross-check.
 */
export function lockfileChecksum(lock: LockfileV1): string {
  return sha256Hex(serializeLockfile(lock));
}
