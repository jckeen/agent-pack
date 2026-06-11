// Public TypeScript types for the Phase 2 install engine.
//
// The runtime zod schemas in ./schemas.ts are the source of truth for
// validation. This file is the source of truth for the *static* developer
// experience.

import type {
  AdapterOutputFile,
  AtomType,
  PermissionSummary,
  ProfileName,
  RiskLevel,
  TargetPlatform,
} from "../schema/types.js";

/**
 * Canonicalization parameters pinned in the lockfile. Phase 2 freezes these to
 * a single set; future lockfile versions may add alternatives.
 */
export interface CanonicalizationSpec {
  algorithm: "sha256";
  encoding: "utf-8";
  lineEndings: "lf";
}

export const CANONICALIZATION: CanonicalizationSpec = Object.freeze({
  algorithm: "sha256",
  encoding: "utf-8",
  lineEndings: "lf",
});

/**
 * Per-file hash record inside the lockfile. Cosign-style: signatures sign file
 * digests, not logical atom groupings, so per-file is the necessary granularity
 * for Phase 4. Phase 2 already produces it.
 */
export interface LockfileFileEntry {
  /** Project-relative path. Must NOT be absolute. */
  path: string;
  /** Hex-lowercase sha256 of canonical bytes (LF normalized). */
  sha256: string;
  /** Byte count of canonical bytes. */
  bytes: number;
  /** create vs. modify — matches AdapterOutputFile.action. */
  action: "create" | "modify";
}

export interface LockfileAtomEntry {
  id: string;
  type: AtomType;
  /** sha256 of the source atom file(s) in the pack — phase-3 provenance hook. */
  sourceChecksum: string;
  /** sha256 of the JOINED, sorted file hashes for this atom. */
  contentChecksum: string;
  /** Per-file output list. */
  outputs: LockfileFileEntry[];
}

export interface LockfileSignatures {
  /** Reserved for Phase 4 (Sigstore/cosign). Empty in Phase 2. */
  manifest?: string;
  provenance?: string;
}

export interface LockfileDependencyEntry {
  /** Reserved for Phase 3 transitive deps. Empty in Phase 2. */
  packId: string;
  version: string;
  resolvedChecksum: string;
}

/**
 * AGENTPACK.lock — committed to git, deterministic across machines.
 * No timestamps, no absolute paths, no machine-specific values.
 */
export interface LockfileV1 {
  lockfileVersion: 1;
  packId: string;
  packVersion: string;
  target: TargetPlatform;
  profile: ProfileName;
  /** Generator versions — semver from package.json at install time. */
  generator: {
    cli: string;
    adapter: string;
  };
  /** sha256 of the raw AGENTPACK.yaml bytes (not parsed-then-stringified). */
  manifestChecksum: string;
  canonicalization: CanonicalizationSpec;
  atoms: LockfileAtomEntry[];
  /** Reserved for Phase 3+. Empty array in Phase 2. */
  dependencies: LockfileDependencyEntry[];
  /** Reserved for Phase 4. Empty object in Phase 2. */
  signatures: LockfileSignatures;
}

/**
 * Per-machine install manifest at `.agentpack/installed/<packId>.json`.
 * Authoritative source for uninstall. NOT committed (per-machine).
 */
export interface InstallManifestV1 {
  manifestVersion: 1;
  packId: string;
  packVersion: string;
  target: TargetPlatform;
  profile: ProfileName;
  /** ISO-8601. Machine-specific; lives here, NEVER in the lockfile. */
  installedAt: string;
  cliVersion: string;
  adapterVersions: Partial<Record<TargetPlatform, string>>;
  /** Files this install CREATED (did not exist before). */
  created: Array<{ path: string; sha256: string }>;
  /** Files this install MODIFIED (existed before, content overwritten). */
  modified: Array<{ path: string; sha256: string }>;
  /** Backups of files we overwrote. backupPath is project-relative. */
  backups: Array<{
    original: string;
    backupPath: string;
    originalSha256: string;
  }>;
  atomIds: string[];
  /**
   * Files installed via merge (marker-block or JSON deep-merge). The fragment
   * is the pack's pristine contribution: verify checks it (not the whole
   * file), and uninstall removes only it — never the user's surrounding
   * content.
   */
  merges?: Array<{
    path: string;
    strategy: "marker" | "json";
    fragment: string;
    fragmentSha256: string;
  }>;
  /** sha256 of the lockfile bytes at install time. */
  lockfileChecksum: string;
  /** Static: was this install reversible at the time we made it? */
  rollbackable: boolean;
  rollbackBlockers?: string[];
}

export type HistoryAction =
  | "install_begin"
  | "install_commit"
  | "install_rollback_recovery"
  | "uninstall"
  | "rollback";

export interface HistoryActor {
  type: "cli" | "ci" | "agent";
  id?: string;
}

/**
 * One line of `.agentpack/history.jsonl`. Append-only, globally sequenced,
 * hash-chained. Phase 2 WAL: install_begin (with plannedFiles) before any file
 * write; install_commit after; absence of commit indicates a crashed install.
 */
export interface HistoryEntryV1 {
  /** Monotonic, ULID-style. */
  id: string;
  action: HistoryAction;
  /** ISO-8601 timestamp. NOT used in any checksum. */
  timestamp: string;
  packId: string;
  packVersion: string;
  target: TargetPlatform;
  profile: ProfileName;
  /** Project-relative path to the install manifest, when applicable. */
  manifestPath?: string;
  /** For action=install_begin: file paths the install plans to write. */
  plannedFiles?: Array<{ path: string; sha256: string }>;
  /**
   * For action=install_begin: project-relative backup directory for this
   * install attempt. Lets the recovery sweep restore overwritten user files
   * when rolling back a crashed install — without this, backups exist on
   * disk but nothing can locate them.
   */
  backupDir?: string;
  /** For action=rollback: id of the history entry rolled back to (or `to`). */
  rolledBackTo?: string;
  /** For action=install_rollback_recovery: id of the begin entry being recovered. */
  recoveredBegin?: string;
  actor: HistoryActor;
  result: "success" | "partial" | "failed";
  error?: string;
  /** Hash chain pointer. Empty string for entry #0. */
  previousEntryId: string;
  /** sha256(canonicalJson(entry minus entryChecksum)). */
  entryChecksum: string;
}

/**
 * The Phase 2 install plan — extends Phase 1 InstallPlan with diff classification.
 */
export interface InstallPlanV2 {
  /** Pack metadata, copied from Phase 1 InstallPlan. */
  packId: string;
  packVersion: string;
  target: TargetPlatform;
  profile: ProfileName;
  atoms: string[];
  riskLevel: RiskLevel;
  permissions: PermissionSummary;
  warnings: string[];
  unsupportedAtoms: string[];
  /** Absolute path. NOT stored in committed files. */
  projectRoot: string;
  /** Files that will be CREATED (no existing path on disk). */
  created: AdapterOutputFile[];
  /** Files that will be MODIFIED (existing content differs). */
  modified: AdapterOutputFile[];
  /**
   * Files that already exist on disk with byte-identical content — install
   * will skip writes. Present for visibility.
   */
  unchanged: AdapterOutputFile[];
  /**
   * Files where the existing on-disk content has no AgentPack marker AND
   * differs from our planned output. Install will refuse unless --force.
   */
  conflicts: Array<{
    file: AdapterOutputFile;
    reason: "no-marker-existing-content" | "other-pack-marker" | "json-collision";
    existingSha256: string;
    otherPackId?: string;
  }>;
  /**
   * Files installed via merge (marker-block or JSON deep-merge) rather than
   * whole-file ownership. The fragment is the pack's pristine contribution;
   * verify checks it instead of the whole file, and uninstall removes only
   * it.
   */
  merges: Array<{
    path: string;
    strategy: "marker" | "json";
    fragment: string;
    fragmentSha256: string;
  }>;
  /** The lockfile that would be produced. */
  lockfile: LockfileV1;
}

/**
 * Verification result.
 */
export interface VerifyResult {
  packId: string;
  /** True when all tracked files match their lockfile hashes. */
  clean: boolean;
  /** Tracked files whose on-disk hash differs. */
  drift: Array<{ path: string; expected: string; actual: string }>;
  /** Tracked files no longer on disk. */
  missing: string[];
  /** True when history chain integrity check ran and passed (only if --chain). */
  chainOk?: boolean;
  /** When --chain ran and failed, the entry index that broke. */
  chainBrokeAt?: number;
}

/**
 * Diff entry returned from `planInstall`. Optimized for printing.
 */
export interface DiffEntry {
  path: string;
  status: "create" | "modify" | "unchanged" | "conflict";
  /** Unified-diff string (set for modify and conflict). */
  diff?: string;
  /** Conflict subtype. */
  conflict?: {
    reason: "no-marker-existing-content" | "other-pack-marker" | "json-collision";
    otherPackId?: string;
  };
}

/**
 * Re-export `AgentpackPaths` from paths.ts so all `./types.js` imports across
 * the install module resolve consistently. The actual definition lives in
 * paths.ts to avoid a circular-import on path utilities.
 */
export type { AgentpackPaths } from "./paths.js";
