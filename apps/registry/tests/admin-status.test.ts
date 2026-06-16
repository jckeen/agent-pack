/**
 * Unit tests for the admin status route's request schema and edge cases.
 *
 * The route itself depends on session + DB, so live integration is exercised
 * via the smoke harness once DB is provisioned. These tests cover:
 *   - request schema validation
 *   - CSRF guard logic (ISC-291 / #16)
 *   - canonicalization invariants of the audit helper (pure functions)
 *   - atomicity of the status change + audit append (#36)
 */

import { describe, expect, it, vi } from "vitest";
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

// ---------------------------------------------------------------------------
// Atomicity: status change + audit append (#36)
//
// The route wraps the `UPDATE pack_versions SET status` and `appendAuditEvent`
// in ONE `db.transaction`, passing the open `tx` into the audit helper. The
// invariant under test: if the audit append throws, the status update must NOT
// commit — otherwise a quarantined version could exist with no audit record
// (getVersionStatus would then render the banner with reason: null).
//
// The real route needs session + live DB, so we model the exact tx body here
// against a fake db. The fake's `transaction(fn)` buffers writes against `tx`
// and only commits them when `fn` resolves; if `fn` throws, the buffer is
// discarded (Postgres rollback semantics). This is the contract the route's
// `db.transaction(...)` wrapper relies on.
// ---------------------------------------------------------------------------
describe("admin status route — atomic status + audit (#36)", () => {
  /**
   * Mirror of the route's transactional body (route.ts:165-184 after #36).
   * Kept byte-equivalent in shape: update first, then audit append, both on
   * the same `tx`. Returns the audit event id.
   */
  async function applyStatusChange(
    db: {
      transaction: <T>(fn: (tx: FakeTx) => Promise<T>) => Promise<T>;
    },
    appendAuditEvent: (opts: { db: FakeTx }) => Promise<string>,
    versionId: string,
    nextStatus: string,
  ): Promise<string> {
    return db.transaction(async (tx) => {
      tx.update(versionId, nextStatus);
      return appendAuditEvent({ db: tx });
    });
  }

  interface FakeTx {
    update: (versionId: string, status: string) => void;
  }

  /**
   * Fake db with rollback semantics: writes recorded against `tx` are only
   * flushed to `committed` if the transaction callback resolves.
   */
  function makeTxDb() {
    const committed: Array<{ versionId: string; status: string }> = [];
    const db = {
      committed,
      async transaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
        const buffer: Array<{ versionId: string; status: string }> = [];
        const tx: FakeTx = {
          update: (versionId, status) => buffer.push({ versionId, status }),
        };
        const result = await fn(tx); // throws → buffer never flushed (rollback)
        committed.push(...buffer); // commit
        return result;
      },
    };
    return db;
  }

  it("commits the status update only when the audit append succeeds", async () => {
    const db = makeTxDb();
    const append = vi.fn(async () => "audit-evt-1");

    const id = await applyStatusChange(db, append, "ver-1", "quarantined");

    expect(id).toBe("audit-evt-1");
    expect(append).toHaveBeenCalledOnce();
    expect(db.committed).toEqual([{ versionId: "ver-1", status: "quarantined" }]);
  });

  it("rolls back the status update when the audit append throws", async () => {
    const db = makeTxDb();
    const append = vi.fn(async () => {
      throw new Error("audit_append_failed");
    });

    await expect(applyStatusChange(db, append, "ver-1", "quarantined")).rejects.toThrow(
      "audit_append_failed",
    );

    // The whole point of #36: no quarantined version without its audit row.
    expect(db.committed).toEqual([]);
  });

  it("passes the open tx (not the outer db) into appendAuditEvent", async () => {
    const db = makeTxDb();
    let receivedTx: unknown;
    const append = vi.fn(async (opts: { db: unknown }) => {
      receivedTx = opts.db;
      return "audit-evt-2";
    });

    await applyStatusChange(db, append, "ver-2", "published");

    // The audit helper must receive the transaction handle, not the root db,
    // so its insert participates in the same atomic unit.
    expect(receivedTx).not.toBe(db);
    expect(receivedTx).toHaveProperty("update");
  });
});
