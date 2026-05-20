/**
 * Token generation primitives. `verifyBearer` needs a DB and isn't tested
 * here — its DB-less branch returns null, which is the cascade we rely on.
 */

import { describe, expect, it } from "vitest";

import { generateToken, hashToken } from "@/lib/tokens";

describe("generateToken", () => {
  it("produces a agp_live_ prefixed 41-char token", () => {
    const { token } = generateToken();
    expect(token.startsWith("agp_live_")).toBe(true);
    expect(token.length).toBe(41);
  });

  it("prefix is the first 12 chars", () => {
    const { token, prefix } = generateToken();
    expect(prefix).toBe(token.slice(0, 12));
    expect(prefix.length).toBe(12);
  });

  it("sha256 is lowercase hex, 64 chars", () => {
    const { sha256 } = generateToken();
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("each call yields a fresh token", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.token).not.toBe(b.token);
    expect(a.sha256).not.toBe(b.sha256);
  });
});

describe("hashToken", () => {
  it("is stable for the same input", () => {
    const t = "agp_live_" + "a".repeat(32);
    expect(hashToken(t)).toBe(hashToken(t));
  });

  it("returns 64 lowercase hex chars", () => {
    const t = "agp_live_" + "b".repeat(32);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});
