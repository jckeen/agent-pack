// Public entry point for @workgraph/core.

// Protocol module — wire shapes for the Phase 3 registry + Phase 5 remote install.
// Source of truth: Plans/PROTOCOL.md.
export * from "./protocol/index.js";

// Iteration-4 modules (Phase 3 + Phase 5).
export * as cache from "./cache/index.js";
export {
  HttpRegistryClient,
  InMemoryRegistryClient,
  IntegrityError,
  makeFixture,
  RegistryError,
  VersionNotFoundError,
  resolveLatestVersion,
  type RegistryClient,
  type HttpRegistryClientOptions,
  type InMemoryFixture,
} from "./registry-client/index.js";
export {
  POLICY_VERSION,
  policyConfigSchema,
  loadPolicy,
  enforcePolicy,
  PolicyParseError,
  type PolicyConfig,
  type PolicyEnforcementPlan,
  type PolicyEnforcementResult,
  type PolicyViolation,
} from "./policy/index.js";

export * from "./schema/types.js";
export { agentPackManifestSchema } from "./schema/agentpack.schema.js";
export {
  loadManifest,
  parseManifestYaml,
  resolveManifestPath,
  MAX_MANIFEST_BYTES,
  ManifestTooLargeError,
} from "./parser/loadManifest.js";
export { validateManifest } from "./validator/validateManifest.js";
export { resolveAtoms } from "./planner/resolveAtoms.js";
export { summarizePermissions } from "./permissions/summarizePermissions.js";
export { computeRisk } from "./risk/computeRisk.js";
export { createInstallPlan } from "./planner/createInstallPlan.js";
export { exportPack } from "./exports/exportPack.js";
export {
  adapters,
  getAdapter,
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  chatgptAdapter,
  genericAdapter,
} from "./adapters/index.js";
export {
  wrapInstructionBlock,
  AtomPathEscapeError,
  AtomReadError,
} from "./adapters/types.js";
export { KNOWN_PERMISSION_CATEGORIES } from "./permissions/summarizePermissions.js";
export {
  SEED_PACKS,
  getSeedPackById,
  getSeedPack,
  allTags,
  type SeedPack,
} from "./seed/seedPacks.js";

// Phase 2 install engine — local install/uninstall/diff/verify/rollback.
export {
  CANONICALIZATION,
  canonicalJson,
  sha256Hex,
  normalizeForHash,
  sha256OfFile,
  sortByPath,
  resolveWorkgraphPaths,
  ensureWorkgraphDirs,
  toRelative,
  fromRelative,
  realpathContained,
  WORKGRAPH_DIR_NAME,
  LOCKFILE_NAME,
  HISTORY_FILE_NAME,
  INSTALLED_DIR_NAME,
  BACKUPS_DIR_NAME,
  installManifestPath,
  sanitizePackIdForFile,
  buildLockfile,
  parseLockfile,
  serializeLockfile,
  lockfileChecksum,
  lockfileSchema,
  installManifestSchema,
  parseInstallManifest,
  serializeInstallManifest,
  readInstallManifest,
  writeInstallManifest,
  deleteInstallManifest,
  listInstallManifests,
  InstallManifestNotFoundError,
  historyEntrySchema,
  appendHistoryEntry,
  recordHistory,
  readHistory,
  verifyChain,
  newHistoryId,
  sealEntry,
  planInstall,
  diffPlan,
  applyInstall,
  uninstall,
  UninstallConflictError,
  verifyInstall,
  rollback,
  recoverIncomplete,
} from "./install/index.js";
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
  WorkgraphPaths,
  ApplyInstallOptions,
  ApplyInstallResult,
  UninstallOptions,
  UninstallResult,
  VerifyOptions,
  RollbackOptions,
  RollbackResult,
  RecoveryResult,
} from "./install/index.js";
