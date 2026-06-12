/**
 * Token generation primitives. `verifyBearer` needs a DB and isn't tested
 * here — its DB-less branch returns null, which is the cascade we rely on.
 */

import { describe, expect, it } from "vitest";

import {
  findUngrantableScope,
  generateToken,
  hashToken,
  requireScope,
  type VerifiedToken,
} from "@/lib/tokens";

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

describe("findUngrantableScope (creation-time entitlement gate)", () => {
  it("refuses to mint admin:registry for anyone, even a publisher member", () => {
    expect(findUngrantableScope(["admin:registry"], ["acme"])).toEqual({
      scope: "admin:registry",
      reason: "admin_scope_not_self_grantable",
    });
  });

  it("refuses a publish scope for a publisher the user is not a member of", () => {
    expect(findUngrantableScope(["publish:packs@trusted"], ["acme"])).toEqual({
      scope: "publish:packs@trusted",
      reason: "not_publisher_member",
    });
  });

  it("refuses read:private for a non-member publisher", () => {
    expect(findUngrantableScope(["read:private@trusted"], [])).toEqual({
      scope: "read:private@trusted",
      reason: "not_publisher_member",
    });
  });

  it("allows a scoped publish for a publisher the user belongs to", () => {
    expect(findUngrantableScope(["publish:packs@acme"], ["acme", "other"])).toBeNull();
  });

  it("allows plain (unscoped) grants — they are gated at use time by membership", () => {
    expect(findUngrantableScope(["read:packs", "publish:packs"], [])).toBeNull();
  });

  it("returns the first offending scope in a mixed list", () => {
    expect(
      findUngrantableScope(["read:packs", "admin:registry", "publish:packs@x"], []),
    ).toEqual({ scope: "admin:registry", reason: "admin_scope_not_self_grantable" });
  });
});

describe("requireScope (use-time defense-in-depth)", () => {
  const mk = (scopes: string[], publisherSlugs: string[]): VerifiedToken => ({
    userId: "u1",
    tokenId: "t1",
    publisherIds: [],
    publisherSlugs,
    scopes,
  });

  it("admin:registry is a super-scope", () => {
    expect(() =>
      requireScope(mk(["admin:registry"], []), "publish:packs", "acme"),
    ).not.toThrow();
  });

  it("a scoped token only works for a publisher the user still belongs to", () => {
    // Token carries publish:packs@acme but the user is no longer a member of acme.
    expect(() =>
      requireScope(mk(["publish:packs@acme"], []), "publish:packs", "acme"),
    ).toThrow();
  });

  it("a scoped token works when membership is intact", () => {
    expect(() =>
      requireScope(mk(["publish:packs@acme"], ["acme"]), "publish:packs", "acme"),
    ).not.toThrow();
  });

  it("plain publish scope requires membership in the target publisher", () => {
    expect(() =>
      requireScope(mk(["publish:packs"], []), "publish:packs", "acme"),
    ).toThrow();
    expect(() =>
      requireScope(mk(["publish:packs"], ["acme"]), "publish:packs", "acme"),
    ).not.toThrow();
  });
});
