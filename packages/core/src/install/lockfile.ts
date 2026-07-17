import { z } from "zod";
import type {
  AdapterOutputFile,
  AtomType,
  ProfileName,
  TargetPlatform,
} from "../schema/types.js";
import type {
  LockfileV1,
  LockfileV2,
  LockfilePackEntry,
  LockfileAtomEntry,
  LockfileFileEntry,
} from "./types.js";
import { CANONICALIZATION } from "./types.js";
import { canonicalJson, sha256Hex, sortByPath } from "./checksum.js";
import { REF_RE } from "../git-source/index.js";

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

/**
 * Provenance block shared by AGENTPACK.lock and the install manifest
 * (sync S1). Discriminated on `kind`; absent entirely on local-path installs.
 */
export const lockfileSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github"),
    id: z.string().min(1),
    // Same ref grammar parseGitId enforces at install time — the schema is
    // the trust boundary for a tampered manifest/lockfile read back later.
    requestedRef: z.string().regex(REF_RE).nullable(),
    resolvedSha: z.string().regex(/^[a-f0-9]{40}$/),
    channel: z.enum(["pinned", "tag", "branch"]),
  }),
  z.object({
    kind: z.literal("registry"),
    id: z.string().min(1),
    registry: z.string().min(1),
    requestedVersion: z.string().min(1).nullable(),
    resolvedVersion: z.string().min(1),
    channel: z.enum(["pinned", "latest"]),
  }),
]);

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
  source: lockfileSourceSchema.optional(),
});

/** One pack's entry in a v2 document — the v1 shape minus the version tag. */
export const lockfilePackEntrySchema = lockfileSchema.omit({ lockfileVersion: true });

export const lockfileV2Schema = z
  .object({
    lockfileVersion: z.literal(2),
    packs: z.record(z.string().min(1), lockfilePackEntrySchema),
  })
  .superRefine((doc, ctx) => {
    for (const [key, entry] of Object.entries(doc.packs)) {
      if (entry.packId !== key) {
        ctx.addIssue({
          code: "custom",
          path: ["packs", key, "packId"],
          message: `entry packId \`${entry.packId}\` does not match its packs key \`${key}\``,
        });
      }
    }
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

/** Strip the version tag off a standalone v1 document, yielding its v2 entry. */
export function lockfileEntryFromV1(lock: LockfileV1): LockfilePackEntry {
  const { lockfileVersion: _v, ...entry } = lock;
  return entry;
}

/** Render a v2 entry back as a standalone single-pack v1 document. */
export function lockfileEntryAsV1(entry: LockfilePackEntry): LockfileV1 {
  return { lockfileVersion: 1, ...entry };
}

/**
 * Parse AGENTPACK.lock from disk in EITHER version. A v1 document (written by
 * a pre-#114 CLI) is interpreted as a single-pack v2 in memory; the first
 * write after that persists the file as v2. Every reader goes through this.
 */
export function parseLockfileDocument(raw: string): LockfileV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `AGENTPACK.lock is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const version =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { lockfileVersion?: unknown }).lockfileVersion
      : undefined;
  if (version === 1) {
    const v1 = lockfileSchema.safeParse(parsed);
    if (!v1.success) {
      throw new Error(
        `AGENTPACK.lock failed schema validation:\n${v1.error.issues
          .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
          .join("\n")}`,
      );
    }
    const lock = v1.data as LockfileV1;
    return { lockfileVersion: 2, packs: { [lock.packId]: lockfileEntryFromV1(lock) } };
  }
  if (version === 2) {
    const v2 = lockfileV2Schema.safeParse(parsed);
    if (!v2.success) {
      throw new Error(
        `AGENTPACK.lock failed schema validation:\n${v2.error.issues
          .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
          .join("\n")}`,
      );
    }
    return v2.data as LockfileV2;
  }
  throw new Error(
    `AGENTPACK.lock has unsupported lockfileVersion ${JSON.stringify(version)} — this CLI reads versions 1 and 2.`,
  );
}

/** Serialize a v2 document to canonical on-disk bytes (same discipline as v1). */
export function serializeLockfileDocument(doc: LockfileV2): string {
  const canonical = canonicalJson(doc);
  const parsed = JSON.parse(canonical) as unknown;
  return JSON.stringify(parsed, sortedReplacer, 2) + "\n";
}

/**
 * Upsert one pack's lock into a v2 document: installing pack B preserves pack
 * A's entry; re-installing/updating pack A replaces only A's entry. `doc`
 * null means no lockfile existed yet. Never mutates its input.
 */
export function upsertLockfileEntry(doc: LockfileV2 | null, lock: LockfileV1): LockfileV2 {
  return {
    lockfileVersion: 2,
    packs: { ...(doc?.packs ?? {}), [lock.packId]: lockfileEntryFromV1(lock) },
  };
}

/**
 * Remove one pack's entry. Returns null when the last entry goes — the caller
 * deletes the file (the lockfile describes the currently installed set).
 * Never mutates its input.
 */
export function removeLockfileEntry(doc: LockfileV2, packId: string): LockfileV2 | null {
  const packs = { ...doc.packs };
  delete packs[packId];
  if (Object.keys(packs).length === 0) return null;
  return { lockfileVersion: 2, packs };
}

/**
 * Per-pack lockfile checksum: sha256 of the entry rendered as a standalone
 * v1 document. For a pack installed by a pre-#114 CLI this equals the
 * whole-file checksum it recorded in the install manifest, so manifests
 * survive the v1 → v2 migration unchanged.
 */
export function lockfileEntryChecksum(entry: LockfilePackEntry): string {
  return lockfileChecksum(lockfileEntryAsV1(entry));
}

/**
 * sha256 of the lockfile bytes as they're written to disk. Used by install
 * manifest's `lockfileChecksum` cross-check.
 */
export function lockfileChecksum(lock: LockfileV1): string {
  return sha256Hex(serializeLockfile(lock));
}
