/**
 * Unit tests for the publisher query layer (`src/queries/publishers.ts`).
 *
 * `userHasPublisherScope` is the publisher-side authorization gate, so its
 * role logic (owner overrides any required role; non-matching role denied) is
 * tested explicitly against a fake Drizzle client.
 */

import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  getPublisherBySlug,
  listUserPublishers,
  userHasPublisherScope,
} from "../src/index.js";
import { publisherMembers, publishers } from "../src/schema/index.js";
import { makeFakeDb } from "./_fake-db.js";

const SAMPLE_PUBLISHER = {
  id: "pub-1",
  slug: "agentpack",
  displayName: "AgentPack",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("getPublisherBySlug", () => {
  it("returns the publisher row when the slug matches", async () => {
    const fake = makeFakeDb([SAMPLE_PUBLISHER]);

    const result = await getPublisherBySlug(fake.db, "agentpack");

    expect(result).toEqual(SAMPLE_PUBLISHER);
    expect(fake.methods()).toEqual(["select", "from", "where", "limit"]);
    expect(fake.argsOf("limit")).toEqual([1]);
    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(eq(publishers.slug, "agentpack"));
  });

  it("returns null when no publisher has the slug", async () => {
    const fake = makeFakeDb([]);

    const result = await getPublisherBySlug(fake.db, "nope");

    expect(result).toBeNull();
  });
});

describe("userHasPublisherScope", () => {
  it("returns false when the user is not a member", async () => {
    const fake = makeFakeDb([]);

    const ok = await userHasPublisherScope(fake.db, "user-1", "pub-1");

    expect(ok).toBe(false);
  });

  it("filters membership on publisherId AND userId", async () => {
    const fake = makeFakeDb([{ role: "maintainer" }]);

    await userHasPublisherScope(fake.db, "user-1", "pub-1");

    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(
      and(eq(publisherMembers.publisherId, "pub-1"), eq(publisherMembers.userId, "user-1")),
    );
  });

  it("returns true for any member when no specific role is required", async () => {
    const fake = makeFakeDb([{ role: "maintainer" }]);

    const ok = await userHasPublisherScope(fake.db, "user-1", "pub-1");

    expect(ok).toBe(true);
  });

  it("returns true when the member's role matches the required role", async () => {
    const fake = makeFakeDb([{ role: "maintainer" }]);

    const ok = await userHasPublisherScope(fake.db, "user-1", "pub-1", "maintainer");

    expect(ok).toBe(true);
  });

  it("returns true for an owner even when a different role is required", async () => {
    const fake = makeFakeDb([{ role: "owner" }]);

    const ok = await userHasPublisherScope(fake.db, "user-1", "pub-1", "maintainer");

    expect(ok).toBe(true);
  });

  it("returns false when the member's role is below the required role", async () => {
    const fake = makeFakeDb([{ role: "maintainer" }]);

    const ok = await userHasPublisherScope(fake.db, "user-1", "pub-1", "owner");

    expect(ok).toBe(false);
  });
});

describe("listUserPublishers", () => {
  it("returns the joined publisher+role rows for the user", async () => {
    const rows = [
      { publisher: SAMPLE_PUBLISHER, role: "owner" },
      { publisher: { ...SAMPLE_PUBLISHER, id: "pub-2" }, role: "maintainer" },
    ];
    const fake = makeFakeDb(rows);

    const result = await listUserPublishers(fake.db, "user-1");

    expect(result).toEqual(rows);
  });

  it("inner-joins publishers and filters on the member userId", async () => {
    const fake = makeFakeDb([]);

    await listUserPublishers(fake.db, "user-1");

    expect(fake.methods()).toEqual(["select", "from", "innerJoin", "where"]);
    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(eq(publisherMembers.userId, "user-1"));
  });

  it("returns an empty array when the user belongs to no publisher", async () => {
    const fake = makeFakeDb([]);

    const result = await listUserPublishers(fake.db, "user-1");

    expect(result).toEqual([]);
  });
});
