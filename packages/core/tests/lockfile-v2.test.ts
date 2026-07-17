// Lockfile v2 (#114): multi-pack AGENTPACK.lock. Unit tests for the document
// shape, the v1 → v2 migration read path, and the merge/remove helpers.
//
// The core invariants under test:
//   • a v1 lockfile parses everywhere as a single-pack v2 document,
//   • per-pack entries mirror LockfileV1 fields exactly (minus lockfileVersion),
//   • the per-pack checksum (standalone-v1 rendering) is byte-stable across
//     the migration, so install manifests written under v1 stay valid.
import { describe, it, expect } from "vitest";
import {
  buildLockfile,
  serializeLockfile,
  lockfileChecksum,
  lockfileEntryFromV1,
  lockfileEntryAsV1,
  lockfileEntryChecksum,
  parseLockfileDocument,
  serializeLockfileDocument,
  upsertLockfileEntry,
  removeLockfileEntry,
  lockfileV2Schema,
} from "../src/install/lockfile.js";
import type { LockfileV1, LockfileV2 } from "../src/install/types.js";

function fixture(packId = "agentpack.test", packVersion = "0.1.0"): LockfileV1 {
  return buildLockfile({
    packId,
    packVersion,
    target: "generic",
    profile: "safe",
    generator: { cli: "0.2.0", adapter: "0.2.0" },
    manifestRawBytes: `agentpack: '1.0'\nmetadata:\n  id: ${packId}\n`,
    atomOutputs: [
      {
        atomId: "code-review",
        atomType: "skill",
        sourceBytes: `skill body of ${packId}`,
        files: [],
        fileHashes: [
          {
            path: `skills/${packId}/SKILL.md`,
            sha256: "a".repeat(64),
            bytes: 100,
            action: "create",
          },
        ],
      },
    ],
  });
}

describe("parseLockfileDocument — migration read path", () => {
  it("reads a v1 lockfile as a single-pack v2 document", () => {
    const v1 = fixture();
    const doc = parseLockfileDocument(serializeLockfile(v1));
    expect(doc.lockfileVersion).toBe(2);
    expect(Object.keys(doc.packs)).toEqual(["agentpack.test"]);
    // The in-memory entry is exactly the v1 content minus lockfileVersion.
    expect(doc.packs["agentpack.test"]).toEqual(lockfileEntryFromV1(v1));
  });

  it("reads a v2 lockfile document", () => {
    const doc = upsertLockfileEntry(null, fixture("pack.a"));
    const round = parseLockfileDocument(serializeLockfileDocument(doc));
    expect(round).toEqual(doc);
  });

  it("rejects an unknown lockfileVersion", () => {
    expect(() =>
      parseLockfileDocument(JSON.stringify({ lockfileVersion: 3, packs: {} })),
    ).toThrow(/lockfileVersion/);
  });

  it("rejects invalid JSON and schema violations", () => {
    expect(() => parseLockfileDocument("not json")).toThrow(/not valid JSON/);
    expect(() => parseLockfileDocument(JSON.stringify({ lockfileVersion: 2 }))).toThrow(
      /schema validation/,
    );
  });

  it("rejects a v2 document whose packs key disagrees with the entry packId", () => {
    const doc = upsertLockfileEntry(null, fixture("pack.a")) as LockfileV2;
    const forged = {
      lockfileVersion: 2,
      packs: { "pack.other": doc.packs["pack.a"] },
    };
    expect(() => parseLockfileDocument(JSON.stringify(forged))).toThrow(/packId/);
  });
});

describe("v1 ↔ entry round-trip byte-equivalence", () => {
  it("entry → standalone v1 → bytes is identical to the original v1 bytes", () => {
    const v1 = fixture();
    const originalBytes = serializeLockfile(v1);
    const entry = lockfileEntryFromV1(v1);
    expect(serializeLockfile(lockfileEntryAsV1(entry))).toBe(originalBytes);
  });

  it("per-pack entry checksum equals the v1 lockfileChecksum — manifests written under v1 stay valid after migration", () => {
    const v1 = fixture();
    const doc = parseLockfileDocument(serializeLockfile(v1));
    const entry = doc.packs["agentpack.test"];
    expect(entry).toBeDefined();
    expect(lockfileEntryChecksum(entry!)).toBe(lockfileChecksum(v1));
  });

  it("source provenance survives the migration read path", () => {
    const v1 = fixture();
    v1.source = {
      kind: "github",
      id: "github:owner/repo",
      requestedRef: "main",
      resolvedSha: "e".repeat(40),
      channel: "branch",
    };
    const doc = parseLockfileDocument(serializeLockfile(v1));
    expect(doc.packs["agentpack.test"]?.source).toEqual(v1.source);
  });
});

describe("upsertLockfileEntry / removeLockfileEntry", () => {
  it("upsert into null starts a v2 document with one pack", () => {
    const doc = upsertLockfileEntry(null, fixture("pack.a"));
    expect(doc.lockfileVersion).toBe(2);
    expect(Object.keys(doc.packs)).toEqual(["pack.a"]);
  });

  it("installing a second pack preserves the first pack's entry", () => {
    const a = fixture("pack.a");
    let doc = upsertLockfileEntry(null, a);
    doc = upsertLockfileEntry(doc, fixture("pack.b"));
    expect(Object.keys(doc.packs).sort()).toEqual(["pack.a", "pack.b"]);
    expect(doc.packs["pack.a"]).toEqual(lockfileEntryFromV1(a));
  });

  it("re-installing a pack replaces only that pack's entry", () => {
    const b = fixture("pack.b");
    let doc = upsertLockfileEntry(null, fixture("pack.a", "0.1.0"));
    doc = upsertLockfileEntry(doc, b);
    doc = upsertLockfileEntry(doc, fixture("pack.a", "0.2.0"));
    expect(doc.packs["pack.a"]?.packVersion).toBe("0.2.0");
    expect(doc.packs["pack.b"]).toEqual(lockfileEntryFromV1(b));
  });

  it("remove drops only the named pack; removing the last pack returns null", () => {
    let doc: LockfileV2 | null = upsertLockfileEntry(null, fixture("pack.a"));
    doc = upsertLockfileEntry(doc, fixture("pack.b"));
    doc = removeLockfileEntry(doc, "pack.a");
    expect(doc).not.toBeNull();
    expect(Object.keys(doc!.packs)).toEqual(["pack.b"]);
    doc = removeLockfileEntry(doc!, "pack.b");
    expect(doc).toBeNull();
  });

  it("upsert does not mutate its input document", () => {
    const doc = upsertLockfileEntry(null, fixture("pack.a"));
    const before = JSON.stringify(doc);
    upsertLockfileEntry(doc, fixture("pack.b"));
    removeLockfileEntry(doc, "pack.a");
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("serializeLockfileDocument", () => {
  it("is deterministic regardless of insertion order", () => {
    const a = fixture("pack.a");
    const b = fixture("pack.b");
    const ab = upsertLockfileEntry(upsertLockfileEntry(null, a), b);
    const ba = upsertLockfileEntry(upsertLockfileEntry(null, b), a);
    expect(serializeLockfileDocument(ab)).toBe(serializeLockfileDocument(ba));
  });

  it("writes lockfileVersion 2 and validates against the v2 schema", () => {
    const doc = upsertLockfileEntry(null, fixture());
    const bytes = serializeLockfileDocument(doc);
    expect(bytes).toContain('"lockfileVersion": 2');
    expect(lockfileV2Schema.parse(JSON.parse(bytes)).lockfileVersion).toBe(2);
  });

  it("contains no timestamps or absolute paths", () => {
    const bytes = serializeLockfileDocument(upsertLockfileEntry(null, fixture()));
    expect(bytes).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(bytes).not.toMatch(/"\//);
  });
});
