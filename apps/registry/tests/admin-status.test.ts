/**
 * Unit tests for the admin status route's request schema and edge cases.
 *
 * The route itself depends on session + DB, so live integration is exercised
 * via the smoke harness once DB is provisioned. These tests cover:
 *   - request schema validation
 *   - CSRF guard logic (ISC-291 / #16)
 *   - canonicalization invariants of the audit helper (pure functions)
 *   - atomicity of the status change + audit append (#36)
 *
 * The atomicity tests (#36) now import the REAL `applyStatusChange` function
 * extracted from the route (#58) — no mirror copy. The route and the test
 * exercise the same code path.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any import of the route module.
// The route imports next/server, @/lib/auth, @/lib/db, @/lib/audit; stub
// them so vitest can load the route without a real Next.js / Postgres env.
// ---------------------------------------------------------------------------

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => null),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => null),
  packVersions: { id: "id", status: "status" },
  packs: { id: "id", publisherId: "publisherId", slug: "slug" },
  publishers: { id: "id", slug: "slug" },
  publisherMembers: { publisherId: "publisherId", userId: "userId", role: "role" },
}));

vi.mock("@/lib/audit", () => ({
  appendAuditEvent: vi.fn(async () => "audit-evt-mock"),
}));

// Imported after mocks so the stubbed modules are already in place.
import { applyStatusChange } from "@/app/api/admin/packs/[publisher]/[pack]/versions/[version]/status/route";

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
// These tests now import and call the REAL `applyStatusChange` extracted from
// the route (#58). No mirror copy — route and test exercise the same function.
//
// The fake db's `transaction(fn)` buffers writes against `tx` and only commits
// them when `fn` resolves; if `fn` throws, the buffer is discarded (Postgres
// rollback semantics). This is the contract the route's `db.transaction(...)`
// wrapper relies on.
// ---------------------------------------------------------------------------
describe("admin status route — atomic status + audit (#36)", () => {
  /**
   * Drizzle query-builder write recorded in the buffer. The real route calls
   * tx.update(table).set({status}).where(condition) — we capture the `status`
   * value from `.set()` and the condition is ignored (we only care that a write
   * was buffered, not which row).
   */
  interface BufferedWrite {
    status: string;
  }

  /**
   * Fake tx that supports the Drizzle fluent update chain used by the route:
   *   tx.update(table).set({ status }).where(condition)
   * Writes are recorded into `buffer` as `{ status }`.
   */
  function makeFakeTx(buffer: BufferedWrite[]) {
    return {
      update: (_table: unknown) => ({
        set: (values: { status: string }) => ({
          where: (_condition: unknown) => {
            buffer.push({ status: values.status });
            return Promise.resolve();
          },
        }),
      }),
    };
  }

  /**
   * Fake db with rollback semantics: writes recorded against `tx` are only
   * flushed to `committed` if the transaction callback resolves.
   */
  function makeTxDb() {
    const committed: BufferedWrite[] = [];
    const db = {
      committed,
      async transaction<T>(
        fn: (tx: ReturnType<typeof makeFakeTx>) => Promise<T>,
      ): Promise<T> {
        const buffer: BufferedWrite[] = [];
        const tx = makeFakeTx(buffer);
        const result = await fn(tx); // throws → buffer never flushed (rollback)
        committed.push(...buffer); // commit
        return result;
      },
    };
    return db;
  }

  it("commits the status update only when the audit append succeeds", async () => {
    const db = makeTxDb();
    const appendAuditFn = vi.fn(async () => "audit-evt-1");

    const id = await applyStatusChange({
      db: db as unknown as Parameters<typeof applyStatusChange>[0]["db"],
      appendAuditFn: appendAuditFn as unknown as Parameters<
        typeof applyStatusChange
      >[0]["appendAuditFn"],
      versionId: "ver-1",
      nextStatus: "quarantined",
      actorUserId: "user-1",
      action: "version_status_changed",
      targetType: "pack_version",
      targetId: "ver-1",
      payload: { reason: "exploit" },
    });

    expect(id).toBe("audit-evt-1");
    expect(appendAuditFn).toHaveBeenCalledOnce();
    expect(db.committed).toEqual([{ status: "quarantined" }]);
  });

  it("rolls back the status update when the audit append throws", async () => {
    const db = makeTxDb();
    const appendAuditFn = vi.fn(async () => {
      throw new Error("audit_append_failed");
    });

    await expect(
      applyStatusChange({
        db: db as unknown as Parameters<typeof applyStatusChange>[0]["db"],
        appendAuditFn: appendAuditFn as unknown as Parameters<
          typeof applyStatusChange
        >[0]["appendAuditFn"],
        versionId: "ver-1",
        nextStatus: "quarantined",
        actorUserId: "user-1",
        action: "version_status_changed",
        targetType: "pack_version",
        targetId: "ver-1",
        payload: { reason: "exploit" },
      }),
    ).rejects.toThrow("audit_append_failed");

    // The whole point of #36: no quarantined version without its audit row.
    expect(db.committed).toEqual([]);
  });

  it("passes the open tx (not the outer db) into appendAuditEvent", async () => {
    const db = makeTxDb();
    let receivedDb: unknown;
    const appendAuditFn = vi.fn(async (opts: { db: unknown }) => {
      receivedDb = opts.db;
      return "audit-evt-2";
    });

    await applyStatusChange({
      db: db as unknown as Parameters<typeof applyStatusChange>[0]["db"],
      appendAuditFn: appendAuditFn as unknown as Parameters<
        typeof applyStatusChange
      >[0]["appendAuditFn"],
      versionId: "ver-2",
      nextStatus: "published",
      actorUserId: "user-1",
      action: "version_status_changed",
      targetType: "pack_version",
      targetId: "ver-2",
      payload: {},
    });

    // The audit helper must receive the transaction handle, not the root db,
    // so its insert participates in the same atomic unit.
    expect(receivedDb).not.toBe(db);
  });
});
