// Public entry for the Phase 2 install engine.

export type {
  CanonicalizationSpec,
  LockfileV1,
  LockfileV2,
  LockfilePackEntry,
  LockfileFileEntry,
  LockfileAtomEntry,
  LockfileSignatures,
  LockfileDependencyEntry,
  LockfileSource,
  InstallManifestV1,
  HistoryAction,
  HistoryActor,
  HistoryEntryV1,
  InstallPlanV2,
  VerifyResult,
  DiffEntry,
  AgentpackPaths,
} from "./types.js";
export { CANONICALIZATION } from "./types.js";

export {
  canonicalJson,
  sha256Hex,
  normalizeForHash,
  sha256OfFile,
  sortByPath,
} from "./checksum.js";

export {
  resolveAgentpackPaths,
  ensureAgentpackDirs,
  toRelative,
  fromRelative,
  realpathContained,
  AGENTPACK_DIR_NAME,
  LOCKFILE_NAME,
  HISTORY_FILE_NAME,
  INSTALLED_DIR_NAME,
  BACKUPS_DIR_NAME,
  installManifestPath,
  sanitizePackIdForFile,
} from "./paths.js";

export {
  buildLockfile,
  parseLockfile,
  serializeLockfile,
  lockfileChecksum,
  lockfileSchema,
  lockfileSourceSchema,
  // Lockfile v2 (#114): multi-pack document + migration helpers.
  lockfileV2Schema,
  lockfilePackEntrySchema,
  parseLockfileDocument,
  serializeLockfileDocument,
  upsertLockfileEntry,
  removeLockfileEntry,
  lockfileEntryFromV1,
  lockfileEntryAsV1,
  lockfileEntryChecksum,
} from "./lockfile.js";

export {
  planUpdate,
  applyUpdate,
  computeExecDelta,
  UpdateConflictError,
} from "./update.js";
export type {
  UpdatePlan,
  UpdateConflict,
  UpdateRemoval,
  PlanUpdateOptions,
  ApplyUpdateOptions,
  ApplyUpdateResult,
} from "./update.js";

export {
  installManifestSchema,
  parseInstallManifest,
  serializeInstallManifest,
  readInstallManifest,
  writeInstallManifest,
  deleteInstallManifest,
  listInstallManifests,
  InstallManifestNotFoundError,
} from "./manifest.js";

export {
  historyEntrySchema,
  appendHistoryEntry,
  recordHistory,
  readHistory,
  verifyChain,
  newHistoryId,
  sealEntry,
} from "./history.js";

export { planInstall, diffPlan } from "./plan.js";
export { applyInstall } from "./apply.js";
export type { ApplyInstallOptions, ApplyInstallResult } from "./apply.js";
export { uninstall, UninstallConflictError } from "./uninstall.js";
export type {
  UninstallOptions,
  UninstallResult,
  LockfileUninstallOutcome,
} from "./uninstall.js";
export { verifyInstall } from "./verify.js";
export type { VerifyOptions } from "./verify.js";
export { rollback } from "./rollback.js";
export type { RollbackOptions, RollbackResult } from "./rollback.js";
export { countIncompleteInstalls, recoverIncomplete } from "./recovery.js";
export type { RecoveryResult } from "./recovery.js";
