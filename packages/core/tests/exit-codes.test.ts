import { describe, expect, it } from "vitest";

import { ExitCode, exitCodeForError } from "../src/protocol/error-codes.js";
import { InstallManifestNotFoundError } from "../src/install/manifest.js";
import { UninstallConflictError } from "../src/install/uninstall.js";
import { BlobNotFoundError, IntegrityError } from "../src/cache/errors.js";
import { VersionNotFoundError } from "../src/registry-client/errors.js";

/**
 * ISC-295: the CLI's `failCleanly` catch-all must map typed domain errors to
 * their pinned exit codes instead of collapsing every uncaught error to 1.
 * `exitCodeForError` is the core-side mapping it delegates to. Matching is by
 * `.name` (not `instanceof`) to keep the protocol module cycle-free, so these
 * tests double as a guard that every mapped error class keeps its stable name.
 */
describe("exitCodeForError", () => {
  it("maps not-found errors to NotFound (8)", () => {
    expect(exitCodeForError(new InstallManifestNotFoundError("acme/pack", "/x"))).toBe(
      ExitCode.NotFound,
    );
    expect(exitCodeForError(new BlobNotFoundError("deadbeef"))).toBe(ExitCode.NotFound);
    expect(exitCodeForError(new VersionNotFoundError("acme", "pack", "1.0.0"))).toBe(
      ExitCode.NotFound,
    );
  });

  it("maps integrity failures to IntegrityError (7)", () => {
    expect(exitCodeForError(new IntegrityError("aaa", "bbb"))).toBe(
      ExitCode.IntegrityError,
    );
  });

  it("maps uninstall conflicts to Conflict (9)", () => {
    expect(exitCodeForError(new UninstallConflictError([]))).toBe(ExitCode.Conflict);
  });

  it("falls back to Generic (1) for unknown errors and non-errors", () => {
    expect(exitCodeForError(new Error("boom"))).toBe(ExitCode.Generic);
    expect(exitCodeForError("a string")).toBe(ExitCode.Generic);
    expect(exitCodeForError(undefined)).toBe(ExitCode.Generic);
    expect(exitCodeForError({ name: "InstallManifestNotFoundError" })).toBe(
      ExitCode.Generic,
    );
  });

  it("keeps mapped error-class names stable (guards the .name contract)", () => {
    expect(new InstallManifestNotFoundError("a/b", "/p").name).toBe(
      "InstallManifestNotFoundError",
    );
    expect(new BlobNotFoundError("x").name).toBe("BlobNotFoundError");
    expect(new VersionNotFoundError("a", "b").name).toBe("VersionNotFoundError");
    expect(new IntegrityError("a", "b").name).toBe("IntegrityError");
    expect(new UninstallConflictError([]).name).toBe("UninstallConflictError");
  });
});
