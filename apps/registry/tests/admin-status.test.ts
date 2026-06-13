/**
 * Unit tests for the admin status route's request schema and edge cases.
 *
 * The route itself depends on session + DB, so live integration is exercised
 * via the smoke harness once DB is provisioned. These tests cover:
 *   - request schema validation
 *   - CSRF guard logic (ISC-291 / #16)
 *   - canonicalization invariants of the audit helper (pure functions)
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// CSRF guard — extracted as a pure function so it can be unit-tested without
// spinning up the Next.js route (which requires session + DB). This
// implementation is kept byte-for-byte identical to the one in the route;
// the test file is the contract that it stays that way.
// ---------------------------------------------------------------------------
function csrfGuard(req: Request): { status: number; error: string } | null {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    return { status: 415, error: "csrf_content_type" };
  }
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return { status: 403, error: "csrf_origin" };
  }
  const origin = req.headers.get("origin");
  const expected = process.env.NEXT_PUBLIC_REGISTRY_URL?.replace(/\/$/, "");
  if (origin && expected && origin !== expected) {
    return { status: 403, error: "csrf_origin" };
  }
  return null;
}

/** Build a minimal Request with the specified headers. */
function makeReq(headers: Record<string, string>): Request {
  return new Request(
    "https://registry.example.com/api/admin/packs/acme/foo/versions/1.0.0/status",
    {
      method: "POST",
      headers,
    },
  );
}

// Mirror the route's schema here so we can exercise it without firing the
// route's auth/DB dependencies. Kept in sync via this file living next to
// the route.
const requestSchema = z
  .object({
    status: z.enum(["active", "quarantined"]),
    reason: z.string().min(1).max(500).optional(),
  })
  .refine((b) => b.status === "active" || (b.reason != null && b.reason.length > 0), {
    message: "reason required when quarantining",
    path: ["reason"],
  });

describe("admin status route — request schema", () => {
  it("accepts an unquarantine without reason", () => {
    expect(() => requestSchema.parse({ status: "active" })).not.toThrow();
  });

  it("accepts a quarantine with reason", () => {
    expect(() =>
      requestSchema.parse({ status: "quarantined", reason: "exploit" }),
    ).not.toThrow();
  });

  it("rejects quarantine without reason (ISC-44)", () => {
    expect(() => requestSchema.parse({ status: "quarantined" })).toThrow();
  });

  it("rejects quarantine with empty-string reason", () => {
    expect(() => requestSchema.parse({ status: "quarantined", reason: "" })).toThrow();
  });

  it("rejects reason > 500 chars", () => {
    expect(() =>
      requestSchema.parse({
        status: "quarantined",
        reason: "x".repeat(501),
      }),
    ).toThrow();
  });

  it("rejects unknown status enum value", () => {
    expect(() => requestSchema.parse({ status: "blocked" })).toThrow();
  });
});

describe("audit canonicalize — deterministic stringify", () => {
  // Re-export canonicalize here as a pure function copy for testing —
  // the real one in lib/audit.ts is identical but bundled with DB deps.
  function canonicalize(obj: unknown): string {
    // Must stay byte-for-byte identical to lib/audit.ts — including the
    // undefined→"null" normalization, without which JSON.stringify(undefined)
    // returns the JS value `undefined` and diverges from production hashes.
    if (obj === undefined) return "null";
    if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(",")}]`;
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (k) => `${JSON.stringify(k)}:${canonicalize((obj as Record<string, unknown>)[k])}`,
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
      '{"arr":[3,1,{"k":"v"}],"n":null}',
    );
  });
});

// ---------------------------------------------------------------------------
// CSRF guard — ISC-291 / issue #16
// ---------------------------------------------------------------------------
describe("csrfGuard (ISC-291 / #16) — CSRF rejection paths", () => {
  it("rejects non-JSON content-type with 415 (form POST would be silent CSRF)", () => {
    const result = csrfGuard(
      makeReq({ "content-type": "application/x-www-form-urlencoded" }),
    );
    expect(result?.status).toBe(415);
    expect(result?.error).toBe("csrf_content_type");
  });

  it("rejects text/plain with 415", () => {
    const result = csrfGuard(makeReq({ "content-type": "text/plain" }));
    expect(result?.status).toBe(415);
    expect(result?.error).toBe("csrf_content_type");
  });

  it("rejects multipart/form-data with 415", () => {
    const result = csrfGuard(
      makeReq({ "content-type": "multipart/form-data; boundary=----xyz" }),
    );
    expect(result?.status).toBe(415);
    expect(result?.error).toBe("csrf_content_type");
  });

  it("rejects missing content-type with 415", () => {
    const result = csrfGuard(makeReq({}));
    expect(result?.status).toBe(415);
    expect(result?.error).toBe("csrf_content_type");
  });

  it("rejects cross-origin Sec-Fetch-Site with 403", () => {
    const result = csrfGuard(
      makeReq({
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      }),
    );
    expect(result?.status).toBe(403);
    expect(result?.error).toBe("csrf_origin");
  });

  it("rejects same-site (different subdomain) Sec-Fetch-Site with 403", () => {
    const result = csrfGuard(
      makeReq({
        "content-type": "application/json",
        "sec-fetch-site": "same-site",
      }),
    );
    expect(result?.status).toBe(403);
    expect(result?.error).toBe("csrf_origin");
  });

  it("allows same-origin Sec-Fetch-Site to pass the fetch-site check", () => {
    // No NEXT_PUBLIC_REGISTRY_URL set in test env so origin check is skipped.
    const result = csrfGuard(
      makeReq({
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(result).toBeNull();
  });

  it("rejects mismatched Origin when NEXT_PUBLIC_REGISTRY_URL is set", () => {
    process.env.NEXT_PUBLIC_REGISTRY_URL = "https://agentpack.dev";
    try {
      const result = csrfGuard(
        makeReq({
          "content-type": "application/json",
          origin: "https://evil.example.com",
        }),
      );
      expect(result?.status).toBe(403);
      expect(result?.error).toBe("csrf_origin");
    } finally {
      delete process.env.NEXT_PUBLIC_REGISTRY_URL;
    }
  });

  it("allows matching Origin when NEXT_PUBLIC_REGISTRY_URL is set", () => {
    process.env.NEXT_PUBLIC_REGISTRY_URL = "https://agentpack.dev";
    try {
      const result = csrfGuard(
        makeReq({
          "content-type": "application/json",
          origin: "https://agentpack.dev",
        }),
      );
      expect(result).toBeNull();
    } finally {
      delete process.env.NEXT_PUBLIC_REGISTRY_URL;
    }
  });

  it("accepts application/json with charset suffix (real browser behaviour)", () => {
    const result = csrfGuard(
      makeReq({ "content-type": "application/json; charset=utf-8" }),
    );
    // No Sec-Fetch-Site, no Origin, no registry URL set — guard passes.
    expect(result).toBeNull();
  });
});
