/**
 * CLI exit codes and registry-error names — protocol-level pinned values.
 *
 * Source of truth: `Plans/PROTOCOL.md` § 5.
 *
 * Phase 1+2 already use 0/1/2/3. Phase 4/5 reserve 4..7 and 9. The numbers are
 * stable across phases and are part of the public contract — workflow scripts
 * and CI depend on them.
 */

export const ExitCode = {
  Success: 0,
  Generic: 1,
  Drift: 2,
  ChainBroken: 3,
  SignatureFailed: 4,
  Unsigned: 5,
  PolicyViolation: 6,
  IntegrityError: 7,
  NotFound: 8,
  Conflict: 9,
} as const;

export type ExitCodeName = keyof typeof ExitCode;
export type ExitCodeValue = (typeof ExitCode)[ExitCodeName];

/**
 * Registry error names returned in API responses' `error` field. The CLI maps
 * these to exit codes via `errorNameToExitCode`.
 */
export const RegistryErrorName = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  Validation: "validation",
  VersionExists: "version_exists",
  PublishExpired: "publish_expired",
  SizeMismatch: "size_mismatch",
  NotFound: "not_found",
  Quarantined: "quarantined",
  ServerError: "server_error",
} as const;

export type RegistryErrorNameValue =
  (typeof RegistryErrorName)[keyof typeof RegistryErrorName];

export function errorNameToExitCode(name: string): ExitCodeValue {
  switch (name) {
    case RegistryErrorName.VersionExists:
      return ExitCode.Conflict;
    case RegistryErrorName.NotFound:
      return ExitCode.NotFound;
    case RegistryErrorName.Unauthorized:
    case RegistryErrorName.Forbidden:
      return ExitCode.Generic;
    default:
      return ExitCode.Generic;
  }
}

/**
 * Map a thrown domain error to its pinned CLI exit code.
 *
 * Matching is by the error's `.name` (every AgentPack error class sets a
 * stable `name`), not `instanceof` — this keeps the protocol module free of
 * import cycles back into install/cache/registry-client. The CLI's
 * `failCleanly` catch-all calls this so a `verify` of an uninstalled pack
 * exits 8 (NotFound) and a cache integrity failure exits 7 — instead of every
 * uncaught error collapsing to the generic 1. Unknown errors stay Generic.
 *
 * CLI-layer usage errors (bad invocation, e.g. NonInteractiveError) are
 * mapped by the CLI itself before this fallback, since their exit semantics
 * (2) are a CLI concern, not a domain one.
 */
export function exitCodeForError(err: unknown): ExitCodeValue {
  if (!(err instanceof Error)) return ExitCode.Generic;
  switch (err.name) {
    case "InstallManifestNotFoundError":
    case "VersionNotFoundError":
    case "BlobNotFoundError":
      return ExitCode.NotFound;
    case "IntegrityError":
      return ExitCode.IntegrityError;
    case "UninstallConflictError":
      return ExitCode.Conflict;
    default:
      return ExitCode.Generic;
  }
}
