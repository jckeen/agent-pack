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
    case RegistryErrorName.Unauthorized:
    case RegistryErrorName.Forbidden:
      return ExitCode.Generic;
    default:
      return ExitCode.Generic;
  }
}
