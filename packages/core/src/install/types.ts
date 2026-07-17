// Public TypeScript types for the Phase 2 install engine.
//
// The runtime zod schemas in ./schemas.ts are the source of truth for
// validation. This file is the source of truth for the *static* developer
// experience.

import type {
  AdapterOutputFile,
  AtomType,
  CompatibilityStatus,
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

/**
 * Where an install came from — the provenance `agentpack update` re-resolves
 * to answer "is a newer version available?". Absent on local-path installs.
 * Every field is a function of the install inputs (never the machine), so
 * lockfile determinism holds.
 */
export type LockfileSource =
  | {
      kind: "github";
      /** Canonical re-fetchable id WITHOUT the ref (e.g. `github:owner/repo#subpath`). */
      id: string;
      /** The ref the user typed; null = repo default branch. */
      requestedRef: string | null;
      /** The 40-hex commit SHA actually installed. */
      resolvedSha: string;
      /**
       * Pinning policy, derived at install time: a 40-hex ref never moves
       * (`pinned`), a tag never moves implicitly (`tag`), a branch or omitted
       * ref is trackable (`branch`).
       */
      channel: "pinned" | "tag" | "branch";
    }
  | {
      kind: "registry";
      /** `<publisher>/<pack>` as resolvable against `registry`. */
      id: string;
      /** Registry base URL the install resolved against. */
      registry: string;
      /** The version the user typed; null = latest published. */
      requestedVersion: string | null;
      /** The concrete version actually installed. */
      resolvedVersion: string;
      /** `pinned` = exact version requested; `latest` = tracks newest published. */
      channel: "pinned" | "latest";
    };

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
  /** Provenance for git/registry installs (sync S1). Absent on local-path installs. */
  source?: LockfileSource;
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
  /**
   * Mirror of the lockfile's provenance block (sync S1). The per-pack source
   * of truth for `agentpack update` — the lockfile is single-pack and may
   * belong to a different pack after a later install.
   */
  source?: LockfileSource;
  /** ISO-8601 timestamp of the last `agentpack update` apply (sync S2). */
  updatedAt?: string;
  /** Pack version this machine ran before the last update (sync S2). */
  previousPackVersion?: string;
  /**
   * Computed risk level of the installed plan (sync S2) — the baseline the
   * policy `update.maxRiskEscalation` gate compares a new version against.
   */
  riskLevel?: RiskLevel;
  /**
   * Install scope (sync S3). `"user"` = installed into `~/.claude` with the
   * user-layout path mapping; `agentpack update` re-plans with the same
   * mapping. Absent = project scope.
   */
  scope?: "user";
}

export type HistoryAction =
  | "install_begin"
  | "install_commit"
  | "install_rollback_recovery"
  | "uninstall"
  | "rollback"
  /**
   * Sync S2: `agentpack update` uses the same WAL discipline as install —
   * `update_begin` (plannedFiles/createdPaths/requiredBackups/backupDir)
   * before any write, `update_commit` after. The recovery sweep treats a
   * dangling `update_begin` exactly like a dangling `install_begin`.
   */
  | "update_begin"
  | "update_commit";

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
   * For action=install_begin: project-relative paths this install CREATES
   * fresh (no pre-existing user file). On rollback these are unlinked
   * unconditionally — a partial/corrupt create has a non-matching hash, so the
   * legacy "unlink only on hash match" rule would leave it behind. Never
   * includes a path that pre-existed on disk, so a user's file is never
   * destroyed. Optional for backward compatibility with older begin entries.
   */
  createdPaths?: string[];
  /**
   * For action=install_begin: project-relative paths of pre-existing user
   * files this install overwrites. Each MUST be restorable from `backupDir` on
   * rollback; a failed restore is a data-loss event that classifies the
   * recovery as unresolved/failed rather than success. Optional for backward
   * compatibility with older begin entries.
   */
  requiredBackups?: string[];
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
  /**
   * Resolved atoms with their declared `type` — the authoritative typed list
   * for type-keyed security gates (e.g. the executable-surface gate). See the
   * note on `InstallPlan.atomTypes`.
   */
  atomTypes: Array<{ id: string; type: AtomType }>;
  riskLevel: RiskLevel;
  permissions: PermissionSummary;
  warnings: string[];
  unsupportedAtoms: string[];
  /**
   * Authored compatibility claim for this target, copied from the Phase 1
   * plan (#134). Absent when the manifest declares nothing for the target.
   */
  authoredCompatibility?: CompatibilityStatus;
  /** Compiler-observed fidelity — see `InstallPlan.observedFidelity` (#134). */
  observedFidelity: CompatibilityStatus;
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
  /** Install scope (sync S3). `"user"` = ~/.claude layout. Absent = project. */
  scope?: "user";
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
