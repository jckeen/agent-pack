// Public entry for the Phase 2 install engine.

export type {
  CanonicalizationSpec,
  LockfileV1,
  LockfileFileEntry,
  LockfileAtomEntry,
  LockfileSignatures,
  LockfileDependencyEntry,
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
} from "./lockfile.js";

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
export {
  uninstall,
  UninstallConflictError,
} from "./uninstall.js";
export type { UninstallOptions, UninstallResult } from "./uninstall.js";
export { verifyInstall } from "./verify.js";
export type { VerifyOptions } from "./verify.js";
export { rollback } from "./rollback.js";
export type { RollbackOptions, RollbackResult } from "./rollback.js";
export { recoverIncomplete } from "./recovery.js";
export type { RecoveryResult } from "./recovery.js";
