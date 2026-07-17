import { afterEach, describe, expect, it } from "vitest";

import { TOKEN_ENV_VAR, TOKEN_MIN_LENGTH, validateTokenEnv } from "../src/auth.js";

/**
 * #63: the connector bearer-token floor is 32 chars (was 16). A 32-char floor
 * matches the `openssl rand -hex 32`-style secrets the docs recommend and
 * aligns with the registry's AUTH_SECRET minimum. Deployments using shorter
 * tokens must rotate — this is an intentional breaking bump.
 */

const originalEnv = process.env[TOKEN_ENV_VAR];

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[TOKEN_ENV_VAR];
  } else {
    process.env[TOKEN_ENV_VAR] = originalEnv;
  }
});

describe("token floor (32 chars, #63)", () => {
  it("sets TOKEN_MIN_LENGTH to 32", () => {
    expect(TOKEN_MIN_LENGTH).toBe(32);
  });

  it("rejects a 16-char token that satisfied the old floor", () => {
    process.env[TOKEN_ENV_VAR] = "a".repeat(16);
    expect(() => validateTokenEnv()).toThrow(/too short/);
  });

  it("rejects a 31-char token", () => {
    process.env[TOKEN_ENV_VAR] = "a".repeat(31);
    expect(() => validateTokenEnv()).toThrow(/too short/);
  });

  it("accepts a 32-char token", () => {
    process.env[TOKEN_ENV_VAR] = "a".repeat(32);
    expect(validateTokenEnv()).toBe("a".repeat(32));
  });

  it("recommends `openssl rand -hex 32` when the token is missing", () => {
    delete process.env[TOKEN_ENV_VAR];
    expect(() => validateTokenEnv()).toThrow(/openssl rand -hex 32/);
  });

  it("recommends `openssl rand -hex 32` when the token is too short", () => {
    process.env[TOKEN_ENV_VAR] = "short";
    expect(() => validateTokenEnv()).toThrow(/openssl rand -hex 32/);
  });
});
