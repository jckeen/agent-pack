/**
 * Unit tests for the pack query layer (`src/queries/packs.ts`).
 *
 * Covers listing (pagination clamps + result/count mapping), slug lookup,
 * version listing, and the semver-aware "latest published version" selection.
 * Driven against fake Drizzle clients that record the query-builder chain.
 */

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  getLatestVersion,
  getPackBySlug,
  getVersion,
  listPackVersions,
  listPacks,
} from "../src/index.js";
import { packs, packVersions, publishers } from "../src/schema/index.js";
import { makeFakeDb, makeMultiResultFakeDb } from "./_fake-db.js";

const PACK = {
  id: "pack-1",
  publisherId: "pub-1",
  slug: "pr-quality",
  name: "PR Quality",
  tags: ["ci"],
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const PUBLISHER = {
  id: "pub-1",
  slug: "agentpack",
  displayName: "AgentPack",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

function versionRow(version: string, status = "published", publishedAt = new Date()) {
  return {
    id: `ver-${version}`,
    packId: "pack-1",
    version,
    status,
    publishedAt,
  };
}

describe("listPacks", () => {
  it("maps joined rows into PackWithPublisher and returns the count", async () => {
    const fake = makeMultiResultFakeDb([
      [{ pack: PACK, publisherSlug: "agentpack" }],
      [{ count: 1 }],
    ]);

    const result = await listPacks(fake.db);

    expect(result.total).toBe(1);
    expect(result.packs).toEqual([{ ...PACK, publisherSlug: "agentpack" }]);
  });

  it("clamps limit to [1,100] and offset to >=0", async () => {
    const fake = makeMultiResultFakeDb([[], [{ count: 0 }]]);

    await listPacks(fake.db, { limit: 5000, offset: -10 });

    expect(fake.argsOf("limit")).toEqual([100]);
    expect(fake.argsOf("offset")).toEqual([0]);
  });

  it("applies the default limit of 50 when unspecified", async () => {
    const fake = makeMultiResultFakeDb([[], [{ count: 0 }]]);

    await listPacks(fake.db);

    expect(fake.argsOf("limit")).toEqual([50]);
    expect(fake.argsOf("offset")).toEqual([0]);
  });

  it("inner-joins publishers and orders by createdAt desc", async () => {
    const fake = makeMultiResultFakeDb([[], [{ count: 0 }]]);

    await listPacks(fake.db);

    expect(fake.methods()).toContain("innerJoin");
    expect(fake.methods()).toContain("orderBy");
  });

  it("builds a tag filter when opts.tag is set", async () => {
    const fake = makeMultiResultFakeDb([[], [{ count: 0 }]]);

    await listPacks(fake.db, { tag: "ci" });

    // The where clause is a SQL fragment; assert it was passed (one per query).
    const whereCalls = fake.calls.filter((c) => c.method === "where");
    expect(whereCalls).toHaveLength(2);
    expect(whereCalls[0]?.args[0]).toBeDefined();
  });

  it("builds a search filter when opts.search is set", async () => {
    const fake = makeMultiResultFakeDb([[], [{ count: 0 }]]);

    await listPacks(fake.db, { search: "code review" });

    const whereCalls = fake.calls.filter((c) => c.method === "where");
    expect(whereCalls).toHaveLength(2);
    expect(whereCalls[0]?.args[0]).toBeDefined();
  });

  it("returns total 0 when the count query yields no row", async () => {
    const fake = makeMultiResultFakeDb([[], []]);

    const result = await listPacks(fake.db);

    expect(result.total).toBe(0);
    expect(result.packs).toEqual([]);
  });
});

describe("getPackBySlug", () => {
  it("returns the pack+publisher when both slugs match", async () => {
    const fake = makeFakeDb([{ pack: PACK, publisher: PUBLISHER }]);

    const result = await getPackBySlug(fake.db, "agentpack", "pr-quality");

    expect(result).toEqual({ pack: PACK, publisher: PUBLISHER });
    expect(fake.methods()).toEqual(["select", "from", "innerJoin", "where", "limit"]);
    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(
      and(eq(publishers.slug, "agentpack"), eq(packs.slug, "pr-quality")),
    );
  });

  it("returns null when no pack matches the slugs", async () => {
    const fake = makeFakeDb([]);

    const result = await getPackBySlug(fake.db, "agentpack", "missing");

    expect(result).toBeNull();
  });
});

describe("listPackVersions", () => {
  it("returns all versions for the pack ordered by publishedAt desc", async () => {
    const rows = [versionRow("0.2.0"), versionRow("0.1.0")];
    const fake = makeFakeDb(rows);

    const result = await listPackVersions(fake.db, "pack-1");

    expect(result).toEqual(rows);
    expect(fake.methods()).toEqual(["select", "from", "where", "orderBy"]);
    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(eq(packVersions.packId, "pack-1"));
  });
});

describe("getLatestVersion", () => {
  it("selects the highest semver among published rows", async () => {
    // Returned out of order; query filters on published, fn sorts by semver.
    const fake = makeFakeDb([
      versionRow("0.9.0"),
      versionRow("0.10.0"),
      versionRow("0.2.0"),
    ]);

    const result = await getLatestVersion(fake.db, "pack-1");

    expect(result?.version).toBe("0.10.0");
  });

  it("ranks a release above its pre-release of the same core version", async () => {
    const fake = makeFakeDb([versionRow("1.0.0-rc.1"), versionRow("1.0.0")]);

    const result = await getLatestVersion(fake.db, "pack-1");

    expect(result?.version).toBe("1.0.0");
  });

  it("filters on packId AND status=published", async () => {
    const fake = makeFakeDb([versionRow("1.0.0")]);

    await getLatestVersion(fake.db, "pack-1");

    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(
      and(eq(packVersions.packId, "pack-1"), eq(packVersions.status, "published")),
    );
  });

  it("orders two pre-releases of the same core version lexically", async () => {
    const fake = makeFakeDb([versionRow("1.0.0-alpha"), versionRow("1.0.0-beta")]);

    const result = await getLatestVersion(fake.db, "pack-1");

    expect(result?.version).toBe("1.0.0-beta");
  });

  it("falls back to string compare for non-semver version strings", async () => {
    const fake = makeFakeDb([versionRow("latest"), versionRow("nightly")]);

    const result = await getLatestVersion(fake.db, "pack-1");

    // Neither matches the semver regex, so localeCompare decides: "nightly" > "latest".
    expect(result?.version).toBe("nightly");
  });

  it("returns null when there are no published versions", async () => {
    const fake = makeFakeDb([]);

    const result = await getLatestVersion(fake.db, "pack-1");

    expect(result).toBeNull();
  });
});

describe("getVersion", () => {
  it("returns the matching version row", async () => {
    const row = versionRow("0.1.0");
    const fake = makeFakeDb([row]);

    const result = await getVersion(fake.db, "pack-1", "0.1.0");

    expect(result).toEqual(row);
    expect(fake.argsOf("limit")).toEqual([1]);
    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(
      and(eq(packVersions.packId, "pack-1"), eq(packVersions.version, "0.1.0")),
    );
  });

  it("returns null when the version does not exist", async () => {
    const fake = makeFakeDb([]);

    const result = await getVersion(fake.db, "pack-1", "9.9.9");

    expect(result).toBeNull();
  });
});
