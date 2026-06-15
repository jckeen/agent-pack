/**
 * Unit tests for the API-token query layer (`src/queries/tokens.ts`).
 *
 * These are auth-adjacent: API tokens gate publish/registry writes, so the
 * exact filter predicates (active-only lookup, owner-scoped revoke) are
 * security-load-bearing. We drive the production functions against a fake
 * Drizzle client that records the query-builder chain and returns canned rows,
 * asserting both the issued operation and the result mapping.
 */

import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  findActiveTokenByHash,
  listUserTokens,
  markTokenUsed,
  mintToken,
  revokeToken,
} from "../src/index.js";
import { apiTokens } from "../src/schema/index.js";
import { makeFakeDb } from "./_fake-db.js";

const SAMPLE_TOKEN = {
  id: "tok-1",
  userId: "user-1",
  publisherId: null,
  name: "ci",
  tokenPrefix: "agp_live_abc",
  tokenSha256: "a".repeat(64),
  scopes: ["publish:packs"],
  revokedAt: null,
  lastUsedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("findActiveTokenByHash", () => {
  it("returns the row when an active token matches the hash", async () => {
    const fake = makeFakeDb([SAMPLE_TOKEN]);

    const result = await findActiveTokenByHash(fake.db, SAMPLE_TOKEN.tokenSha256);

    expect(result).toEqual(SAMPLE_TOKEN);
  });

  it("issues a single-row select against api_tokens", async () => {
    const fake = makeFakeDb([SAMPLE_TOKEN]);

    await findActiveTokenByHash(fake.db, SAMPLE_TOKEN.tokenSha256);

    expect(fake.methods()).toEqual(["select", "from", "where", "limit"]);
    expect(fake.argsOf("from")).toEqual([apiTokens]);
    expect(fake.argsOf("limit")).toEqual([1]);
  });

  it("filters on hash AND not-revoked (active-only)", async () => {
    const fake = makeFakeDb([SAMPLE_TOKEN]);

    await findActiveTokenByHash(fake.db, SAMPLE_TOKEN.tokenSha256);

    const [predicate] = fake.argsOf("where") as [unknown];
    // The predicate must be the AND of a hash-equality and a revokedAt IS NULL
    // guard — a revoked token must never resolve as active.
    expect(predicate).toEqual(
      and(eq(apiTokens.tokenSha256, SAMPLE_TOKEN.tokenSha256), isNull(apiTokens.revokedAt)),
    );
  });

  it("returns null when no active token matches", async () => {
    const fake = makeFakeDb([]);

    const result = await findActiveTokenByHash(fake.db, "deadbeef");

    expect(result).toBeNull();
  });
});

describe("mintToken", () => {
  it("inserts the mapped row and returns the persisted token", async () => {
    const fake = makeFakeDb([SAMPLE_TOKEN]);

    const result = await mintToken(fake.db, {
      userId: "user-1",
      name: "ci",
      tokenPrefix: "agp_live_abc",
      tokenSha256: SAMPLE_TOKEN.tokenSha256,
      scopes: ["publish:packs"],
    });

    expect(result).toEqual(SAMPLE_TOKEN);
    expect(fake.methods()).toEqual(["insert", "values", "returning"]);
    expect(fake.argsOf("insert")).toEqual([apiTokens]);
  });

  it("defaults publisherId to null when omitted", async () => {
    const fake = makeFakeDb([SAMPLE_TOKEN]);

    await mintToken(fake.db, {
      userId: "user-1",
      name: "ci",
      tokenPrefix: "agp_live_abc",
      tokenSha256: SAMPLE_TOKEN.tokenSha256,
      scopes: ["publish:packs"],
    });

    const [values] = fake.argsOf("values") as [Record<string, unknown>];
    expect(values.publisherId).toBeNull();
  });

  it("passes through an explicit publisherId and all scopes", async () => {
    const fake = makeFakeDb([SAMPLE_TOKEN]);

    await mintToken(fake.db, {
      userId: "user-1",
      publisherId: "pub-9",
      name: "deploy",
      tokenPrefix: "agp_live_xyz",
      tokenSha256: "b".repeat(64),
      scopes: ["publish:packs", "read:packs"],
    });

    const [values] = fake.argsOf("values") as [Record<string, unknown>];
    expect(values).toMatchObject({
      userId: "user-1",
      publisherId: "pub-9",
      name: "deploy",
      tokenPrefix: "agp_live_xyz",
      tokenSha256: "b".repeat(64),
      scopes: ["publish:packs", "read:packs"],
    });
  });

  it("throws when the insert returns no row", async () => {
    const fake = makeFakeDb([]);

    await expect(
      mintToken(fake.db, {
        userId: "user-1",
        name: "ci",
        tokenPrefix: "agp_live_abc",
        tokenSha256: SAMPLE_TOKEN.tokenSha256,
        scopes: [],
      }),
    ).rejects.toThrow("mintToken: insert returned no row");
  });
});

describe("revokeToken", () => {
  it("returns true when a row was revoked", async () => {
    const fake = makeFakeDb([{ id: "tok-1" }]);

    const ok = await revokeToken(fake.db, "tok-1", "user-1");

    expect(ok).toBe(true);
    expect(fake.methods()).toEqual(["update", "set", "where", "returning"]);
    expect(fake.argsOf("update")).toEqual([apiTokens]);
  });

  it("scopes the revoke to the owning user (id AND userId)", async () => {
    const fake = makeFakeDb([{ id: "tok-1" }]);

    await revokeToken(fake.db, "tok-1", "user-1");

    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(
      and(eq(apiTokens.id, "tok-1"), eq(apiTokens.userId, "user-1")),
    );
  });

  it("sets revokedAt to a Date", async () => {
    const fake = makeFakeDb([{ id: "tok-1" }]);

    await revokeToken(fake.db, "tok-1", "user-1");

    const [patch] = fake.argsOf("set") as [{ revokedAt: unknown }];
    expect(patch.revokedAt).toBeInstanceOf(Date);
  });

  it("returns false when no matching row is found (wrong owner / unknown id)", async () => {
    const fake = makeFakeDb([]);

    const ok = await revokeToken(fake.db, "tok-1", "intruder");

    expect(ok).toBe(false);
  });
});

describe("listUserTokens", () => {
  it("returns all tokens for the user", async () => {
    const rows = [SAMPLE_TOKEN, { ...SAMPLE_TOKEN, id: "tok-2" }];
    const fake = makeFakeDb(rows);

    const result = await listUserTokens(fake.db, "user-1");

    expect(result).toEqual(rows);
  });

  it("filters on userId equality", async () => {
    const fake = makeFakeDb([]);

    await listUserTokens(fake.db, "user-1");

    expect(fake.methods()).toEqual(["select", "from", "where"]);
    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(eq(apiTokens.userId, "user-1"));
  });

  it("returns an empty array when the user has no tokens", async () => {
    const fake = makeFakeDb([]);

    const result = await listUserTokens(fake.db, "user-1");

    expect(result).toEqual([]);
  });
});

describe("markTokenUsed", () => {
  it("updates lastUsedAt for the given token id", async () => {
    const fake = makeFakeDb([]);

    await markTokenUsed(fake.db, "tok-1");

    expect(fake.methods()).toEqual(["update", "set", "where"]);
    expect(fake.argsOf("update")).toEqual([apiTokens]);
    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(eq(apiTokens.id, "tok-1"));
  });

  it("sets lastUsedAt via the now() SQL expression", async () => {
    const fake = makeFakeDb([]);

    await markTokenUsed(fake.db, "tok-1");

    const [patch] = fake.argsOf("set") as [{ lastUsedAt: unknown }];
    expect(patch.lastUsedAt).toBeDefined();
  });
});
