/**
 * Issue #35 fix 3 — a verified signature must be persistable into the lockfile
 * so a later `verify --sig` doesn't falsely report the pack unsigned.
 *
 * `buildLockfile` historically hardcoded `signatures: {}`. It now accepts an
 * optional pre-encoded signature envelope and writes it to
 * `signatures.manifest`, round-tripping through parse/serialize.
 */

import { describe, expect, it } from "vitest";

import {
  buildLockfile,
  parseLockfile,
  serializeLockfile,
} from "../src/install/lockfile.js";

const SIG_B64 = Buffer.from(
  JSON.stringify({ envelopeVersion: 2, marker: "test" }),
  "utf-8",
).toString("base64");

function baseInput() {
  return {
    packId: "acme.demo",
    packVersion: "1.0.0",
    target: "generic" as const,
    profile: "safe" as const,
    generator: { cli: "0.0.0", adapter: "0.0.0" },
    manifestRawBytes: "name: demo\n",
    atomOutputs: [],
  };
}

describe("buildLockfile signature persistence", () => {
  it("leaves signatures empty when no envelope is supplied (back-compat)", () => {
    const lock = buildLockfile(baseInput());
    expect(lock.signatures).toEqual({});
  });

  it("writes the supplied envelope to signatures.manifest", () => {
    const lock = buildLockfile({ ...baseInput(), signatureManifestB64: SIG_B64 });
    expect(lock.signatures.manifest).toBe(SIG_B64);
  });

  it("survives serialize → parse round-trip", () => {
    const lock = buildLockfile({ ...baseInput(), signatureManifestB64: SIG_B64 });
    const reparsed = parseLockfile(serializeLockfile(lock));
    expect(reparsed.signatures.manifest).toBe(SIG_B64);
  });
});
