// Public entry point for @agentpack/core.

// Protocol module — wire shapes for the Phase 3 registry + Phase 5 remote install.
// Source of truth: Plans/PROTOCOL.md.
export * from "./protocol/index.js";

// Phase 4 signing & verification (Sigstore keyless).
export * as signing from "./signing/index.js";

// v0.5 git-source install path — install AgentPacks directly from a git ref,
// no registry required. Registry stays available as an optional convenience.
export {
  parseGitId,
  fetchGitPack,
  resolveGitSourceSha,
  type GitSource,
  type FetchGitPackOptions,
  type FetchGitPackResult,
} from "./git-source/index.js";

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
  enforceUpdatePolicy,
  PolicyParseError,
  type PolicyConfig,
  type PolicyEnforcementPlan,
  type PolicyEnforcementResult,
  type PolicyViolation,
  type UpdatePolicyPlan,
  type UpdatePolicyResult,
  type UpdatePolicyViolation,
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
export { resolveAtoms, UnknownProfileError } from "./planner/resolveAtoms.js";
export { selectAtomVariants, type VariantSelection } from "./planner/selectAtomVariants.js";
export { summarizePermissions } from "./permissions/summarizePermissions.js";
export { computeRisk } from "./risk/computeRisk.js";
export {
  createInstallPlan,
  deriveObservedFidelity,
  UnsupportedTargetError,
} from "./planner/createInstallPlan.js";
export { exportPack } from "./exports/exportPack.js";
export { exportPlugin } from "./exports/exportPlugin.js";
export type { ExportPluginOptions, ExportPluginResult } from "./exports/exportPlugin.js";
export { exportMcpb } from "./exports/exportMcpb.js";
export type {
  ExportMcpbOptions,
  ExportMcpbResult,
  McpbManifest,
} from "./exports/exportMcpb.js";
export { exportChat } from "./exports/exportChat.js";
export type {
  ExportChatOptions,
  ExportChatResult,
  ChatSkillArtifact,
  ChatSkillKind,
  ChatConnector,
  ChatConnectorsDoc,
  ChatPortabilityEntry,
} from "./exports/exportChat.js";
export { portabilityFor, summarizePortability } from "./portability.js";
export type {
  PortabilityCeiling,
  PortabilityInfo,
  PortabilitySummary,
} from "./portability.js";
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
  readAtomFile,
  readAtomDirectory,
  resolveInsidePack,
  AtomPathEscapeError,
  AtomReadError,
} from "./adapters/types.js";
export { KNOWN_PERMISSION_CATEGORIES } from "./permissions/summarizePermissions.js";
// Agent Skills spec (agentskills.io) — validation, synthesis, conformance.
export {
  AGENT_SKILLS_ALLOWED_FIELDS,
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_COMPATIBILITY_MAX_LENGTH,
  conformSkillMd,
  normalizeSkillSlug,
  renderSkillMd,
  validateSkillAtoms,
  validateSkillMdContent,
  type AgentSkillFrontmatter,
  type ConformSkillMdResult,
} from "./skills/agentskills.js";
export {
  SEED_PACKS,
  getSeedPackById,
  getSeedPack,
  allTags,
  type SeedPack,
} from "./seed/seedPacks.js";

// `agentpack import` — compile an existing CLAUDE.md/AGENTS.md into a pack.
export {
  importClaudeMd,
  writeImport,
  foldImportInto,
  type FoldChange,
  parseClaudeMd,
  buildManifest,
  slugify,
  importCodexDir,
  parseCodex,
  buildCodexManifest,
  importClaudeCodeDir,
  parseClaudeCode,
  buildClaudeCodeManifest,
  importChatgptGptDir,
  parseChatgptGpt,
  buildChatgptManifest,
  KNOWLEDGE_RAG_WARNING,
  openapiToMcp,
  transpileOpenApiText,
  toToolName,
  type ImportResult,
  type ImportOptions,
  type ParsedClaudeMd,
  type ParsedSection,
  type ParseWarning,
  type BuildManifestOptions,
  type BuildManifestResult,
  type ImportFile,
  type ImportCodexOptions,
  type BuildCodexManifestOptions,
  type BuildCodexManifestResult,
  type ParsedCodex,
  type CodexSkill,
  type CodexMcpServer,
  type CodexHook,
  type CodexSubagent,
  type CodexWarning,
  type ImportClaudeCodeOptions,
  type BuildClaudeCodeManifestOptions,
  type BuildClaudeCodeManifestResult,
  type ParsedClaudeCode,
  type ClaudeCodeSkill,
  type ClaudeCodeMcpServer,
  type ClaudeCodeHook,
  type ClaudeCodeSubagent,
  type ClaudeCodeCommand,
  type ClaudeCodeWarning,
  type ImportChatgptGptOptions,
  type BuildChatgptManifestOptions,
  type BuildChatgptManifestResult,
  type ParsedChatgptGpt,
  type ChatgptKnowledgeFile,
  type ChatgptWarning,
  type TranspiledMcp,
  type McpTool,
  type McpToolInputSchema,
  type McpAuth,
  type McpAuthScheme,
} from "./importer/index.js";

// Phase 2 install engine — local install/uninstall/diff/verify/rollback.
export {
  CANONICALIZATION,
  canonicalJson,
  sha256Hex,
  normalizeForHash,
  sha256OfFile,
  sortByPath,
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
  buildLockfile,
  parseLockfile,
  serializeLockfile,
  lockfileChecksum,
  lockfileSchema,
  lockfileSourceSchema,
  lockfileV2Schema,
  lockfilePackEntrySchema,
  parseLockfileDocument,
  serializeLockfileDocument,
  upsertLockfileEntry,
  removeLockfileEntry,
  lockfileEntryFromV1,
  lockfileEntryAsV1,
  lockfileEntryChecksum,
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
  countIncompleteInstalls,
  recoverIncomplete,
  planUpdate,
  applyUpdate,
  computeExecDelta,
  UpdateConflictError,
} from "./install/index.js";
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
  ApplyInstallOptions,
  ApplyInstallResult,
  UninstallOptions,
  UninstallResult,
  LockfileUninstallOutcome,
  VerifyOptions,
  RollbackOptions,
  RollbackResult,
  RecoveryResult,
  UpdatePlan,
  UpdateConflict,
  UpdateRemoval,
  PlanUpdateOptions,
  ApplyUpdateOptions,
  ApplyUpdateResult,
} from "./install/index.js";
