import { describe, it, expect } from "vitest";
import {
  buildLockfile,
  serializeLockfile,
  parseLockfile,
  lockfileSchema,
  lockfileChecksum,
} from "../src/install/lockfile.js";
import type { LockfileV1 } from "../src/install/types.js";

function fixture(overrides: Partial<Parameters<typeof buildLockfile>[0]> = {}): LockfileV1 {
  return buildLockfile({
    packId: "workgraph.test",
    packVersion: "0.1.0",
    target: "generic",
    profile: "safe",
    generator: { cli: "0.2.0", adapter: "0.2.0" },
    manifestRawBytes: "agentpack: '1.0'\nmetadata:\n  id: workgraph.test\n",
    atomOutputs: [
      {
        atomId: "code-review",
        atomType: "skill",
        sourceBytes: "skill body",
        files: [],
        fileHashes: [
          { path: "skills/code-review/SKILL.md", sha256: "a".repeat(64), bytes: 100, action: "create" },
        ],
      },
    ],
    ...overrides,
  });
}

describe("buildLockfile", () => {
  it("produces a valid LockfileV1 shape", () => {
    const lock = fixture();
    const parsed = lockfileSchema.parse(lock);
    expect(parsed.lockfileVersion).toBe(1);
    expect(parsed.packId).toBe("workgraph.test");
    expect(parsed.atoms).toHaveLength(1);
    expect(parsed.atoms[0]?.outputs).toHaveLength(1);
  });

  it("contains no timestamps anywhere (determinism)", () => {
    const serialized = serializeLockfile(fixture());
    expect(serialized).not.toMatch(/installedAt|createdAt|timestamp/);
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("two builds with identical inputs produce identical bytes", () => {
    const a = serializeLockfile(fixture());
    const b = serializeLockfile(fixture());
    expect(a).toBe(b);
  });

  it("pins canonicalization spec", () => {
    expect(fixture().canonicalization).toEqual({
      algorithm: "sha256",
      encoding: "utf-8",
      lineEndings: "lf",
    });
  });

  it("reserves empty signatures/dependencies for Phase 3+", () => {
    const lock = fixture();
    expect(lock.signatures).toEqual({});
    expect(lock.dependencies).toEqual([]);
  });

  it("sorts atoms by id deterministically", () => {
    const lock = buildLockfile({
      packId: "p",
      packVersion: "1.0",
      target: "generic",
      profile: "safe",
      generator: { cli: "0.2.0", adapter: "0.2.0" },
      manifestRawBytes: "x",
      atomOutputs: [
        { atomId: "z", atomType: "skill", sourceBytes: "", files: [], fileHashes: [] },
        { atomId: "a", atomType: "rule", sourceBytes: "", files: [], fileHashes: [] },
        { atomId: "m", atomType: "instruction", sourceBytes: "", files: [], fileHashes: [] },
      ],
    });
    expect(lock.atoms.map((a) => a.id)).toEqual(["a", "m", "z"]);
  });

  it("sorts outputs within an atom by path", () => {
    const lock = buildLockfile({
      packId: "p",
      packVersion: "1.0",
      target: "generic",
      profile: "safe",
      generator: { cli: "0.2.0", adapter: "0.2.0" },
      manifestRawBytes: "x",
      atomOutputs: [
        {
          atomId: "a",
          atomType: "skill",
          sourceBytes: "",
          files: [],
          fileHashes: [
            { path: "z.md", sha256: "0".repeat(64), bytes: 1, action: "create" },
            { path: "a.md", sha256: "1".repeat(64), bytes: 1, action: "create" },
          ],
        },
      ],
    });
    expect(lock.atoms[0]?.outputs.map((o) => o.path)).toEqual(["a.md", "z.md"]);
  });
});

describe("serialize/parse roundtrip", () => {
  it("survives a round-trip", () => {
    const lock = fixture();
    const round = parseLockfile(serializeLockfile(lock));
    expect(round).toEqual(lock);
  });

  it("emits stable pretty-printed bytes", () => {
    const s = serializeLockfile(fixture());
    expect(s.endsWith("\n")).toBe(true);
    expect(s).toContain('"lockfileVersion": 1');
  });
});

describe("parseLockfile", () => {
  it("rejects non-JSON input", () => {
    expect(() => parseLockfile("not json")).toThrow(/not valid JSON/);
  });

  it("rejects schema violations", () => {
    const bad = JSON.stringify({ lockfileVersion: 1 });
    expect(() => parseLockfile(bad)).toThrow(/schema validation/);
  });

  it("rejects absolute paths in outputs", () => {
    const lock = fixture();
    if (lock.atoms[0]?.outputs[0]) {
      lock.atoms[0].outputs[0].path = "/absolute/path";
    }
    const ser = JSON.stringify(lock);
    expect(() => parseLockfile(ser)).toThrow(/project-relative/);
  });
});

describe("lockfileChecksum", () => {
  it("is deterministic across two builds with identical inputs", () => {
    const a = lockfileChecksum(fixture());
    const b = lockfileChecksum(fixture());
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes when content changes", () => {
    const a = lockfileChecksum(fixture());
    const b = lockfileChecksum(fixture({ packVersion: "9.9.9" }));
    expect(a).not.toBe(b);
  });
});
