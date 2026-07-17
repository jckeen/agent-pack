import { describe, expect, it } from "vitest";

import { AUTH_SECRET_MIN_LENGTH, validateRegistryAuthEnv } from "@/lib/auth-env";

/**
 * Startup guards for the registry's auth surface (#63 B2 + S1).
 *
 * When DATABASE_URL is set the registry is "active" and must refuse to start
 * with empty GitHub OAuth credentials or a missing/short AUTH_SECRET —
 * silently initializing a provider that can never sign in is worse than
 * failing loudly. When DATABASE_URL is unset, the no-DB dev path stays fully
 * unconfigured (graceful cascade, ISC-223).
 */

const VALID = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/registry",
  GITHUB_ID: "Iv1.example-client-id",
  GITHUB_SECRET: "example-client-secret",
  AUTH_SECRET: "a".repeat(AUTH_SECRET_MIN_LENGTH),
};

describe("validateRegistryAuthEnv", () => {
  it("returns null when DATABASE_URL is unset (no-DB dev path)", () => {
    expect(validateRegistryAuthEnv({})).toBeNull();
    // Even with partial/broken auth config — DB-less mode never throws.
    expect(validateRegistryAuthEnv({ GITHUB_ID: "", AUTH_SECRET: "x" })).toBeNull();
  });

  it("returns the validated values when everything is present", () => {
    const env = validateRegistryAuthEnv({ ...VALID });
    expect(env).toEqual({
      githubId: VALID.GITHUB_ID,
      githubSecret: VALID.GITHUB_SECRET,
      authSecret: VALID.AUTH_SECRET,
    });
  });

  it("throws when GITHUB_ID is missing", () => {
    const env = { ...VALID } as Record<string, string>;
    delete env["GITHUB_ID"];
    expect(() => validateRegistryAuthEnv(env)).toThrow(/GITHUB_ID/);
  });

  it("throws when GITHUB_ID is empty or whitespace", () => {
    expect(() => validateRegistryAuthEnv({ ...VALID, GITHUB_ID: "" })).toThrow(/GITHUB_ID/);
    expect(() => validateRegistryAuthEnv({ ...VALID, GITHUB_ID: "   " })).toThrow(
      /GITHUB_ID/,
    );
  });

  it("throws when GITHUB_SECRET is missing or empty", () => {
    const env = { ...VALID } as Record<string, string>;
    delete env["GITHUB_SECRET"];
    expect(() => validateRegistryAuthEnv(env)).toThrow(/GITHUB_SECRET/);
    expect(() => validateRegistryAuthEnv({ ...VALID, GITHUB_SECRET: "" })).toThrow(
      /GITHUB_SECRET/,
    );
  });

  it("throws when AUTH_SECRET is missing", () => {
    const env = { ...VALID } as Record<string, string>;
    delete env["AUTH_SECRET"];
    expect(() => validateRegistryAuthEnv(env)).toThrow(/AUTH_SECRET/);
  });

  it("throws when AUTH_SECRET is shorter than the minimum", () => {
    expect(() =>
      validateRegistryAuthEnv({
        ...VALID,
        AUTH_SECRET: "a".repeat(AUTH_SECRET_MIN_LENGTH - 1),
      }),
    ).toThrow(/AUTH_SECRET/);
  });

  it("accepts an AUTH_SECRET exactly at the minimum length", () => {
    const env = validateRegistryAuthEnv({
      ...VALID,
      AUTH_SECRET: "b".repeat(AUTH_SECRET_MIN_LENGTH),
    });
    expect(env?.authSecret).toBe("b".repeat(AUTH_SECRET_MIN_LENGTH));
  });

  it("reports every problem in one error, not just the first", () => {
    // Operators fix env files in one pass — the message must name all gaps.
    expect(() => validateRegistryAuthEnv({ DATABASE_URL: VALID.DATABASE_URL })).toThrow(
      /GITHUB_ID[\s\S]*GITHUB_SECRET[\s\S]*AUTH_SECRET/,
    );
  });

  it("suggests how to generate a valid AUTH_SECRET", () => {
    expect(() => validateRegistryAuthEnv({ ...VALID, AUTH_SECRET: "short" })).toThrow(
      /openssl rand/,
    );
  });

  it("enforces a 32-char floor", () => {
    expect(AUTH_SECRET_MIN_LENGTH).toBe(32);
  });
});
