/**
 * Smoke tests for the protocol zod schemas as consumed by the registry API
 * routes. Verifies the registry's wire contract matches `@workgraph/core`'s.
 */

import { describe, expect, it } from "vitest";

import {
  publishInitRequestSchema,
  publishFinalizeRequestSchema,
  TOKEN_REGEX,
  versionStatusSchema,
} from "@workgraph/core";

describe("publishInitRequestSchema", () => {
  const ok = {
    publisher: "workgraph",
    pack: "pr-quality",
    version: "0.1.0",
    manifestSha256: "a".repeat(64),
    manifestBytes: 1024,
    files: [{ path: "SKILL.md", sha256: "b".repeat(64), bytes: 1024 }],
    metadata: { name: "PR Quality", description: "x", tags: [], compatibilities: [] },
  };

  it("accepts a well-formed body", () => {
    expect(() => publishInitRequestSchema.parse(ok)).not.toThrow();
  });

  it("rejects bad publisher slug", () => {
    expect(() =>
      publishInitRequestSchema.parse({ ...ok, publisher: "Bad Slug!" })
    ).toThrow();
  });

  it("rejects non-semver version", () => {
    expect(() =>
      publishInitRequestSchema.parse({ ...ok, version: "v0.1.0" })
    ).toThrow();
  });

  it("rejects file path with ..", () => {
    expect(() =>
      publishInitRequestSchema.parse({
        ...ok,
        files: [{ path: "../secret", sha256: "b".repeat(64), bytes: 1024 }],
      })
    ).toThrow();
  });

  it("rejects non-hex sha256", () => {
    expect(() =>
      publishInitRequestSchema.parse({ ...ok, manifestSha256: "x".repeat(64) })
    ).toThrow();
  });
});

describe("publishFinalizeRequestSchema", () => {
  it("requires uuid publishId", () => {
    expect(() =>
      publishFinalizeRequestSchema.parse({ publishId: "not-a-uuid" })
    ).toThrow();
  });
  it("accepts uuid publishId", () => {
    expect(() =>
      publishFinalizeRequestSchema.parse({
        publishId: "550e8400-e29b-41d4-a716-446655440000",
      })
    ).not.toThrow();
  });
});

describe("TOKEN_REGEX", () => {
  it("matches wgp_live_<32 hex>", () => {
    expect(TOKEN_REGEX.test("wgp_live_" + "a".repeat(32))).toBe(true);
  });
  it("rejects wrong prefix", () => {
    expect(TOKEN_REGEX.test("wgp_test_" + "a".repeat(32))).toBe(false);
  });
  it("rejects short body", () => {
    expect(TOKEN_REGEX.test("wgp_live_" + "a".repeat(16))).toBe(false);
  });
});

describe("versionStatusSchema", () => {
  it("accepts canonical statuses", () => {
    for (const s of [
      "published",
      "deprecated",
      "yanked",
      "quarantined",
      "blocked",
    ]) {
      expect(() => versionStatusSchema.parse(s)).not.toThrow();
    }
  });
  it("rejects unknown status", () => {
    expect(() => versionStatusSchema.parse("invented")).toThrow();
  });
});
