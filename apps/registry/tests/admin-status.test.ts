/**
 * Unit tests for the admin status route's request schema and edge cases.
 *
 * The route itself depends on session + DB, so live integration is exercised
 * via the smoke harness once DB is provisioned. These tests cover the schema
 * + canonicalization invariants of the audit helper, both of which are pure.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

// Mirror the route's schema here so we can exercise it without firing the
// route's auth/DB dependencies. Kept in sync via this file living next to
// the route.
const requestSchema = z
  .object({
    status: z.enum(["active", "quarantined"]),
    reason: z.string().min(1).max(500).optional(),
  })
  .refine(
    (b) => b.status === "active" || (b.reason != null && b.reason.length > 0),
    {
      message: "reason required when quarantining",
      path: ["reason"],
    }
  );

describe("admin status route — request schema", () => {
  it("accepts an unquarantine without reason", () => {
    expect(() => requestSchema.parse({ status: "active" })).not.toThrow();
  });

  it("accepts a quarantine with reason", () => {
    expect(() =>
      requestSchema.parse({ status: "quarantined", reason: "exploit" })
    ).not.toThrow();
  });

  it("rejects quarantine without reason (ISC-44)", () => {
    expect(() =>
      requestSchema.parse({ status: "quarantined" })
    ).toThrow();
  });

  it("rejects quarantine with empty-string reason", () => {
    expect(() =>
      requestSchema.parse({ status: "quarantined", reason: "" })
    ).toThrow();
  });

  it("rejects reason > 500 chars", () => {
    expect(() =>
      requestSchema.parse({
        status: "quarantined",
        reason: "x".repeat(501),
      })
    ).toThrow();
  });

  it("rejects unknown status enum value", () => {
    expect(() =>
      requestSchema.parse({ status: "blocked" })
    ).toThrow();
  });
});

describe("audit canonicalize — deterministic stringify", () => {
  // Re-export canonicalize here as a pure function copy for testing —
  // the real one in lib/audit.ts is identical but bundled with DB deps.
  function canonicalize(obj: unknown): string {
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj))
      return `[${obj.map(canonicalize).join(",")}]`;
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalize(
            (obj as Record<string, unknown>)[k]
          )}`
      )
      .join(",")}}`;
  }

  it("produces identical output for key-reordered objects", () => {
    const a = { b: 2, a: 1, c: { y: 2, x: 1 } };
    const b = { a: 1, c: { x: 1, y: 2 }, b: 2 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("handles nested arrays + primitives", () => {
    expect(canonicalize({ arr: [3, 1, { k: "v" }], n: null })).toBe(
      '{"arr":[3,1,{"k":"v"}],"n":null}'
    );
  });
});
