/**
 * Query-function signature smoke tests. Verify the exports exist and accept
 * the expected argument shapes. No live DB needed.
 */

import { describe, expect, it } from "vitest";

import {
  abortPublish,
  createPendingPublish,
  findActiveTokenByHash,
  getDb,
  getLatestVersion,
  getPackBySlug,
  getPendingPublish,
  getPublisherBySlug,
  listPackVersions,
  listPacks,
  listUserTokens,
  markPublishCompleted,
  markTokenUsed,
  mintToken,
  revokeToken,
  userHasPublisherScope,
} from "../src/index.js";

describe("query exports", () => {
  it("getDb returns null without DATABASE_URL", () => {
    delete process.env.DATABASE_URL;
    expect(getDb()).toBeNull();
  });

  it("all query helpers are exported as functions", () => {
    expect(typeof getPackBySlug).toBe("function");
    expect(typeof listPacks).toBe("function");
    expect(typeof listPackVersions).toBe("function");
    expect(typeof getLatestVersion).toBe("function");
    expect(typeof getPublisherBySlug).toBe("function");
    expect(typeof userHasPublisherScope).toBe("function");
    expect(typeof findActiveTokenByHash).toBe("function");
    expect(typeof mintToken).toBe("function");
    expect(typeof revokeToken).toBe("function");
    expect(typeof listUserTokens).toBe("function");
    expect(typeof markTokenUsed).toBe("function");
    expect(typeof createPendingPublish).toBe("function");
    expect(typeof getPendingPublish).toBe("function");
    expect(typeof markPublishCompleted).toBe("function");
    expect(typeof abortPublish).toBe("function");
  });
});
