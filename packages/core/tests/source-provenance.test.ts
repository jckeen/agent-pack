// Sync S1 (#110): the lockfile and install manifest carry an optional
// `source` provenance block so an install remembers where it came from —
// the fact `agentpack update` needs to answer "where would an update come
// from?". Local-path installs have NO source field and must stay
// byte-identical to pre-S1 lockfiles.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildLockfile,
  serializeLockfile,
  parseLockfile,
  lockfileSchema,
} from "../src/install/lockfile.js";
import {
  parseInstallManifest,
  serializeInstallManifest,
  readInstallManifest,
} from "../src/install/manifest.js";
import { planInstall, applyInstall, resolveAgentpackPaths } from "../src/install/index.js";
import type { LockfileSource, LockfileV1 } from "../src/install/types.js";

const EXAMPLE_PACK = path.resolve(__dirname, "../../../examples/pr-quality");
const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

const SHA = "e188eea340cf693a2a4f30a62a3d1e2f4b5c6d7e";

const GITHUB_SOURCE: LockfileSource = {
  kind: "github",
  id: "github:jckeen/agent-pack#examples/pr-quality",
  requestedRef: "master",
  resolvedSha: SHA,
  channel: "branch",
};

const REGISTRY_SOURCE: LockfileSource = {
  kind: "registry",
  id: "agentpack-smoke/pr-quality",
  registry: "https://agentpack.dev",
  requestedVersion: null,
  resolvedVersion: "1.2.0",
  channel: "latest",
};

function lockFixture(): LockfileV1 {
  return buildLockfile({
    packId: "agentpack.test",
    packVersion: "0.1.0",
    target: "generic",
    profile: "safe",
    generator: { cli: "0.2.0", adapter: "0.2.0" },
    manifestRawBytes: "agentpack: '1.0'\nmetadata:\n  id: agentpack.test\n",
    atomOutputs: [
      {
        atomId: "code-review",
        atomType: "skill",
        sourceBytes: "skill body",
        files: [],
        fileHashes: [
          {
            path: "skills/code-review/SKILL.md",
            sha256: "a".repeat(64),
            bytes: 100,
            action: "create",
          },
        ],
      },
    ],
  });
}

describe("lockfile source provenance", () => {
  it("a github source block round-trips through serialize/parse", () => {
    const lock = lockFixture();
    lock.source = GITHUB_SOURCE;
    const back = parseLockfile(serializeLockfile(lock));
    expect(back.source).toEqual(GITHUB_SOURCE);
  });

  it("a registry source block round-trips through serialize/parse", () => {
    const lock = lockFixture();
    lock.source = REGISTRY_SOURCE;
    const back = parseLockfile(serializeLockfile(lock));
    expect(back.source).toEqual(REGISTRY_SOURCE);
  });

  it("a lockfile without source serializes with NO source key (byte-stability for local installs)", () => {
    const bytes = serializeLockfile(lockFixture());
    expect(bytes).not.toContain('"source"');
    // And parse keeps it absent rather than defaulting.
    expect(parseLockfile(bytes).source).toBeUndefined();
  });

  it("rejects a malformed resolvedSha (not 40-hex)", () => {
    const lock = lockFixture();
    lock.source = { ...GITHUB_SOURCE, resolvedSha: "not-a-sha" };
    const parsed = lockfileSchema.safeParse(JSON.parse(serializeLockfile(lock)));
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown channel", () => {
    const lock = lockFixture();
    lock.source = { ...GITHUB_SOURCE, channel: "nightly" as never };
    const parsed = lockfileSchema.safeParse(JSON.parse(serializeLockfile(lock)));
    expect(parsed.success).toBe(false);
  });
});

describe("install manifest source provenance", () => {
  it("round-trips a source block", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-src-prov-"));
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    plan.lockfile.source = GITHUB_SOURCE;
    await applyInstall({ plan, actor: { type: "cli", id: "test" } });
    const ws = await resolveAgentpackPaths(dir);
    const manifest = await readInstallManifest(ws, plan.packId);
    expect(manifest.source).toEqual(GITHUB_SOURCE);
    // Manifest serializer round-trip preserves it too.
    expect(parseInstallManifest(serializeInstallManifest(manifest)).source).toEqual(
      GITHUB_SOURCE,
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a local-path install manifest has NO source field", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-src-local-"));
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan, actor: { type: "cli", id: "test" } });
    const ws = await resolveAgentpackPaths(dir);
    const manifest = await readInstallManifest(ws, plan.packId);
    expect(manifest.source).toBeUndefined();
    expect(serializeInstallManifest(manifest)).not.toContain('"source"');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("source schema ref grammar", () => {
  it("rejects a requestedRef outside the git ref alphabet (tampered manifest boundary)", () => {
    const lock = lockFixture();
    lock.source = { ...GITHUB_SOURCE, requestedRef: "main\nHost:evil" };
    const parsed = lockfileSchema.safeParse(JSON.parse(JSON.stringify(lock)));
    expect(parsed.success).toBe(false);
  });
});
