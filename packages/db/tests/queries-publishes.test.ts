/**
 * Unit tests for the publish-flow query layer (`src/queries/publishes.ts`).
 *
 * Drives the production functions against a fake Drizzle client, asserting the
 * pending-publish row is mapped with status "pending" and the lifecycle
 * transitions (completed/aborted) issue the right scoped update.
 */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  abortPublish,
  createPendingPublish,
  getPendingPublish,
  markPublishCompleted,
} from "../src/index.js";
import { publishes } from "../src/schema/index.js";
import { makeFakeDb } from "./_fake-db.js";

const EXPIRES = new Date("2026-06-14T12:00:00Z");

const SAMPLE_PUBLISH = {
  id: "pub-req-1",
  publisherSlug: "agentpack",
  packSlug: "pr-quality",
  version: "0.1.0",
  status: "pending" as const,
  packId: null,
  expiresAt: EXPIRES,
  createdBy: "user-1",
  presignedFiles: [],
  createdAt: new Date("2026-06-14T11:00:00Z"),
};

const INPUT = {
  publisherSlug: "agentpack",
  packSlug: "pr-quality",
  version: "0.1.0",
  createdBy: "user-1",
  expiresAt: EXPIRES,
  presignedFiles: [
    {
      path: "manifest.yaml",
      sha256: "a".repeat(64),
      bytes: 256,
      r2Key: "agentpack/pr-quality/0.1.0/manifest.yaml",
      presignedUrl: "https://r2.example/put",
      presignedHeaders: { "content-type": "application/x-yaml" },
    },
  ],
};

describe("createPendingPublish", () => {
  it("inserts a pending publish and returns the persisted row", async () => {
    const fake = makeFakeDb([SAMPLE_PUBLISH]);

    const result = await createPendingPublish(fake.db, INPUT);

    expect(result).toEqual(SAMPLE_PUBLISH);
    expect(fake.methods()).toEqual(["insert", "values", "returning"]);
    expect(fake.argsOf("insert")).toEqual([publishes]);
  });

  it("maps input fields and forces status to 'pending'", async () => {
    const fake = makeFakeDb([SAMPLE_PUBLISH]);

    await createPendingPublish(fake.db, INPUT);

    const [values] = fake.argsOf("values") as [Record<string, unknown>];
    expect(values).toMatchObject({
      publisherSlug: "agentpack",
      packSlug: "pr-quality",
      version: "0.1.0",
      status: "pending",
      expiresAt: EXPIRES,
      createdBy: "user-1",
      presignedFiles: INPUT.presignedFiles,
    });
  });

  it("throws when the insert returns no row", async () => {
    const fake = makeFakeDb([]);

    await expect(createPendingPublish(fake.db, INPUT)).rejects.toThrow(
      "createPendingPublish: insert returned no row",
    );
  });
});

describe("getPendingPublish", () => {
  it("returns the publish row for the id", async () => {
    const fake = makeFakeDb([SAMPLE_PUBLISH]);

    const result = await getPendingPublish(fake.db, "pub-req-1");

    expect(result).toEqual(SAMPLE_PUBLISH);
    expect(fake.methods()).toEqual(["select", "from", "where", "limit"]);
    expect(fake.argsOf("limit")).toEqual([1]);
    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(eq(publishes.id, "pub-req-1"));
  });

  it("returns null when no publish has the id", async () => {
    const fake = makeFakeDb([]);

    const result = await getPendingPublish(fake.db, "missing");

    expect(result).toBeNull();
  });
});

describe("markPublishCompleted", () => {
  it("sets status to completed and records the packId, scoped by id", async () => {
    const fake = makeFakeDb([]);

    await markPublishCompleted(fake.db, "pub-req-1", "pack-42");

    expect(fake.methods()).toEqual(["update", "set", "where"]);
    expect(fake.argsOf("update")).toEqual([publishes]);
    const [patch] = fake.argsOf("set") as [Record<string, unknown>];
    expect(patch).toEqual({ status: "completed", packId: "pack-42" });
    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(eq(publishes.id, "pub-req-1"));
  });
});

describe("abortPublish", () => {
  it("sets status to aborted, scoped by id", async () => {
    const fake = makeFakeDb([]);

    await abortPublish(fake.db, "pub-req-1");

    expect(fake.methods()).toEqual(["update", "set", "where"]);
    const [patch] = fake.argsOf("set") as [Record<string, unknown>];
    expect(patch).toEqual({ status: "aborted" });
    const [predicate] = fake.argsOf("where") as [unknown];
    expect(predicate).toEqual(eq(publishes.id, "pub-req-1"));
  });
});
