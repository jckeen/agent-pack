/**
 * Type-inference smoke tests for the Drizzle schema. These compile against
 * Drizzle's type system without opening a DB connection.
 *
 * Satisfies ISC-178.
 */

import { describe, expect, it } from "vitest";

import {
  apiTokens,
  atoms,
  auditEvents,
  accounts,
  compatibilities,
  packFiles,
  packVersions,
  packs,
  publisherMembers,
  publishers,
  publishes,
  reviews,
  sessions,
  TABLE_NAMES,
  users,
  VERSION_STATUS,
  verificationTokens,
} from "../src/index.js";

describe("TABLE_NAMES", () => {
  it("pins every table name verbatim", () => {
    expect(TABLE_NAMES).toEqual({
      users: "users",
      publishers: "publishers",
      publisherMembers: "publisher_members",
      packs: "packs",
      packVersions: "pack_versions",
      packSignatures: "pack_signatures",
      atoms: "atoms",
      packFiles: "pack_files",
      compatibilities: "compatibilities",
      apiTokens: "api_tokens",
      publishes: "publishes",
      reviews: "reviews",
      auditEvents: "audit_events",
      accounts: "accounts",
      sessions: "sessions",
      verificationTokens: "verification_tokens",
    });
  });
});

describe("VERSION_STATUS", () => {
  it("matches the protocol enum order", () => {
    expect(VERSION_STATUS).toEqual([
      "published",
      "deprecated",
      "yanked",
      "quarantined",
      "blocked",
    ]);
  });
});

describe("schema column inference", () => {
  it("users row shape compiles with required fields", () => {
    const row: typeof users.$inferInsert = {
      githubId: "gh-1",
      username: "alice",
    };
    expect(row.githubId).toBe("gh-1");
  });

  it("publishers row inserts with slug + displayName", () => {
    const row: typeof publishers.$inferInsert = {
      slug: "agentpack",
      displayName: "AgentPack",
    };
    expect(row.slug).toBe("agentpack");
  });

  it("publisher_members composite PK columns are present", () => {
    const row: typeof publisherMembers.$inferInsert = {
      publisherId: "00000000-0000-0000-0000-000000000000",
      userId: "00000000-0000-0000-0000-000000000000",
      role: "owner",
    };
    expect(row.role).toBe("owner");
  });

  it("packs row carries name, slug, publisherId", () => {
    const row: typeof packs.$inferInsert = {
      publisherId: "00000000-0000-0000-0000-000000000000",
      slug: "pr-quality",
      name: "PR Quality",
    };
    expect(row.slug).toBe("pr-quality");
  });

  it("pack_versions row requires manifest_sha256 + manifest_r2_key", () => {
    const row: typeof packVersions.$inferInsert = {
      packId: "00000000-0000-0000-0000-000000000000",
      version: "0.1.0",
      manifestSha256: "a".repeat(64),
      manifestR2Key: "agentpack/pr-quality/0.1.0/manifest.yaml",
      publishedBy: "00000000-0000-0000-0000-000000000000",
    };
    expect(row.version).toBe("0.1.0");
  });

  it("atoms row carries atom_id + type + risk_level + metadata", () => {
    const row: typeof atoms.$inferInsert = {
      packVersionId: "00000000-0000-0000-0000-000000000000",
      atomId: "code-review",
      type: "skill",
      riskLevel: "low",
      metadata: { description: "code review" },
    };
    expect(row.atomId).toBe("code-review");
  });

  it("pack_files row tracks path/sha256/bytes/r2_key", () => {
    const row: typeof packFiles.$inferInsert = {
      packVersionId: "00000000-0000-0000-0000-000000000000",
      path: "SKILL.md",
      sha256: "a".repeat(64),
      bytes: 1024,
      r2Key: "agentpack/pr-quality/0.1.0/SKILL.md",
    };
    expect(row.path).toBe("SKILL.md");
  });

  it("compatibilities row has target + status", () => {
    const row: typeof compatibilities.$inferInsert = {
      packVersionId: "00000000-0000-0000-0000-000000000000",
      target: "claude-code",
      status: "supported",
    };
    expect(row.status).toBe("supported");
  });

  it("api_tokens row stores sha256 + prefix + scopes", () => {
    const row: typeof apiTokens.$inferInsert = {
      userId: "00000000-0000-0000-0000-000000000000",
      name: "ci",
      tokenPrefix: "agp_live_xxx",
      tokenSha256: "a".repeat(64),
      scopes: ["publish:packs"],
    };
    expect(row.scopes).toEqual(["publish:packs"]);
  });

  it("publishes row tracks presigned files", () => {
    const row: typeof publishes.$inferInsert = {
      publisherSlug: "agentpack",
      packSlug: "pr-quality",
      version: "0.1.0",
      status: "pending",
      expiresAt: new Date(),
      createdBy: "00000000-0000-0000-0000-000000000000",
      presignedFiles: [],
    };
    expect(row.status).toBe("pending");
  });

  it("reviews row enforces rating + body", () => {
    const row: typeof reviews.$inferInsert = {
      packVersionId: "00000000-0000-0000-0000-000000000000",
      userId: "00000000-0000-0000-0000-000000000000",
      rating: 5,
      body: "ok",
    };
    expect(row.rating).toBe(5);
  });

  it("audit_events row carries chain primitives", () => {
    const row: typeof auditEvents.$inferInsert = {
      action: "publish",
      targetType: "pack_version",
      targetId: "00000000-0000-0000-0000-000000000000",
      entryChecksum: "a".repeat(64),
      payload: {},
    };
    expect(row.action).toBe("publish");
  });

  it("authjs accounts table matches adapter shape", () => {
    const row: typeof accounts.$inferInsert = {
      userId: "00000000-0000-0000-0000-000000000000",
      type: "oauth",
      provider: "github",
      providerAccountId: "1",
    };
    expect(row.provider).toBe("github");
  });

  it("authjs sessions row stores sessionToken + expires", () => {
    const row: typeof sessions.$inferInsert = {
      sessionToken: "s",
      userId: "00000000-0000-0000-0000-000000000000",
      expires: new Date(),
    };
    expect(row.sessionToken).toBe("s");
  });

  it("authjs verification_tokens row has identifier+token+expires", () => {
    const row: typeof verificationTokens.$inferInsert = {
      identifier: "i",
      token: "t",
      expires: new Date(),
    };
    expect(row.identifier).toBe("i");
  });
});
