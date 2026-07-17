// Lockfile v2 (#114): end-to-end multi-pack behavior of AGENTPACK.lock through
// applyInstall / verifyInstall / uninstall / the core update engine, including
// the on-disk v1 → v2 migration (a v1 file written by an older CLI).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  planInstall,
  applyInstall,
  verifyInstall,
  uninstall,
  resolveAgentpackPaths,
  readInstallManifest,
} from "../src/install/index.js";
import { planUpdate, applyUpdate } from "../src/install/update.js";
import {
  parseLockfileDocument,
  serializeLockfile,
  lockfileEntryAsV1,
} from "../src/install/lockfile.js";
import type { LockfileV2 } from "../src/install/types.js";

const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Write a minimal claude-code-target pack. Each pack gets a disjoint skill
 * output (`.claude/skills/<slug>/SKILL.md`) plus a marker-merged CLAUDE.md
 * span, so two packs coexist in one project (the generic adapter can't: it
 * hardcodes whole-file `agentpack.json`/`README-agent.md` outputs that
 * conflict between packs).
 */
async function writePack(
  dir: string,
  opts: { id: string; slug: string; version: string; instructionBody: string },
): Promise<void> {
  await fs.writeFile(
    path.join(dir, "AGENTPACK.yaml"),
    `agentpack: "1.0"
metadata:
  id: "${opts.id}"
  name: "Fixture ${opts.slug}"
  slug: "${opts.slug}"
  description: "Multi-pack lockfile fixture."
  version: "${opts.version}"
  license: "MIT"
  publisher: "fixture"
  authors:
    - name: "Fixture"
      email: "fixture@example.com"
  tags:
    - test
compatibility:
  targets:
    claude-code:
      status: supported
permissions:
  filesystem:
    read:
      - "."
  package_installation: false
  model_provider_key_access: false
security:
  risk_level: low
  risk_summary: "Low."
  requires_review: false
  signed: false
profiles:
  full:
    description: "Everything."
    include:
      - "*"
atoms:
  - id: "instruction:house"
    type: instruction
    name: "House Style"
    description: "A persistent instruction."
    path: "atoms/instructions/house.md"
    risk_level: low
    permissions: []
  - id: "skill:${opts.slug}"
    type: skill
    name: "Skill ${opts.slug}"
    description: "A skill."
    path: "atoms/skills/${opts.slug}"
    skill_format: "agentskills"
    risk_level: low
    permissions: []
exports:
  default_profile: full
  output_dir: "dist"
  lockfile: "AGENTPACK.lock"
adapters:
  claude-code:
    enabled: true
    output:
      instructions: "CLAUDE.md"
      skills: ".claude/skills"
`,
    "utf8",
  );
  await fs.mkdir(path.join(dir, "atoms/instructions"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "atoms/instructions/house.md"),
    opts.instructionBody,
    "utf8",
  );
  await fs.mkdir(path.join(dir, `atoms/skills/${opts.slug}`), { recursive: true });
  await fs.writeFile(
    path.join(dir, `atoms/skills/${opts.slug}/SKILL.md`),
    // Version-independent body: a version-bump reinstall must classify as
    // `unchanged` (content changes go through the update engine instead).
    `---\nname: ${opts.slug}\ndescription: Use this skill for ${opts.slug}.\n---\n\n# ${opts.slug}\n`,
    "utf8",
  );
}

async function installPack(
  project: string,
  opts: { id: string; slug: string; version: string; instructionBody?: string },
): Promise<string> {
  const packDir = await tempDir(`agentpack-lockv2-${opts.slug}-`);
  await writePack(packDir, {
    ...opts,
    instructionBody: opts.instructionBody ?? `# House of ${opts.slug}\n`,
  });
  const plan = await planInstall({
    source: packDir,
    target: "claude-code",
    projectRoot: project,
    generator: GEN,
  });
  await applyInstall({ plan, actor: { type: "cli", id: "test" } });
  return packDir;
}

async function readLockDoc(project: string): Promise<LockfileV2 | null> {
  const raw = await fs
    .readFile(path.join(project, "AGENTPACK.lock"), "utf8")
    .catch(() => null);
  return raw === null ? null : parseLockfileDocument(raw);
}

const A = { id: "fixture.pack-a", slug: "alpha", version: "0.1.0" };
const B = { id: "fixture.pack-b", slug: "beta", version: "0.1.0" };

describe("applyInstall merges into a multi-pack lockfile", () => {
  it("installing pack B preserves pack A's entry", async () => {
    const project = await tempDir("agentpack-lockv2-proj-");
    await installPack(project, A);
    const afterA = await readLockDoc(project);
    expect(Object.keys(afterA!.packs)).toEqual([A.id]);

    await installPack(project, B);
    const afterB = await readLockDoc(project);
    expect(afterB!.lockfileVersion).toBe(2);
    expect(Object.keys(afterB!.packs).sort()).toEqual([A.id, B.id]);
    expect(afterB!.packs[A.id]).toEqual(afterA!.packs[A.id]);
  });

  it("reinstalling pack A replaces only A's entry", async () => {
    const project = await tempDir("agentpack-lockv2-proj-");
    await installPack(project, A);
    await installPack(project, B);
    const before = await readLockDoc(project);

    await installPack(project, { ...A, version: "0.2.0" });
    const after = await readLockDoc(project);
    expect(after!.packs[A.id]?.packVersion).toBe("0.2.0");
    expect(after!.packs[B.id]).toEqual(before!.packs[B.id]);
  });

  it("both packs verify clean, and verify stays clean for A after B installs", async () => {
    const project = await tempDir("agentpack-lockv2-proj-");
    await installPack(project, A);
    await installPack(project, B);
    for (const packId of [A.id, B.id]) {
      const r = await verifyInstall({ packId, projectRoot: project });
      expect(r.clean, `${packId}: ${JSON.stringify(r.drift)}`).toBe(true);
    }
  });

  it("verify flags a tampered lockfile entry as drift", async () => {
    const project = await tempDir("agentpack-lockv2-proj-");
    await installPack(project, A);
    await installPack(project, B);
    const lockPath = path.join(project, "AGENTPACK.lock");
    const doc = (await readLockDoc(project))!;
    doc.packs[A.id]!.packVersion = "9.9.9";
    await fs.writeFile(lockPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
    const a = await verifyInstall({ packId: A.id, projectRoot: project });
    expect(a.clean).toBe(false);
    expect(a.drift.some((d) => d.path === "AGENTPACK.lock")).toBe(true);
    // B's entry is untouched — no cross-pack false positive.
    const b = await verifyInstall({ packId: B.id, projectRoot: project });
    expect(b.clean, JSON.stringify(b.drift)).toBe(true);
  });

  it("refuses to install over a corrupt AGENTPACK.lock without writing anything", async () => {
    const project = await tempDir("agentpack-lockv2-proj-");
    const lockPath = path.join(project, "AGENTPACK.lock");
    await fs.writeFile(lockPath, "{ this is not a lockfile", "utf8");
    const packDir = await tempDir("agentpack-lockv2-corrupt-");
    await writePack(packDir, { ...A, instructionBody: "# House\n" });
    const plan = await planInstall({
      source: packDir,
      target: "claude-code",
      projectRoot: project,
      generator: GEN,
    });
    await expect(applyInstall({ plan, actor: { type: "cli" } })).rejects.toThrow(
      /AGENTPACK\.lock/,
    );
    // Zero writes: the corrupt lockfile is untouched and no pack files landed.
    expect(await fs.readFile(lockPath, "utf8")).toBe("{ this is not a lockfile");
    expect(
      await fs.readFile(path.join(project, "CLAUDE.md"), "utf8").catch(() => null),
    ).toBeNull();
  });
});

describe("uninstall removes only its own lockfile entry", () => {
  it("uninstalling A keeps B's entry; uninstalling the last pack deletes the file", async () => {
    const project = await tempDir("agentpack-lockv2-proj-");
    await installPack(project, A);
    await installPack(project, B);

    const first = await uninstall({ packId: A.id, projectRoot: project });
    expect(first.lockfile).toBe("entry-removed");
    const doc = await readLockDoc(project);
    expect(Object.keys(doc!.packs)).toEqual([B.id]);

    const second = await uninstall({ packId: B.id, projectRoot: project });
    expect(second.lockfile).toBe("file-removed");
    expect(await readLockDoc(project)).toBeNull();
  });

  it("uninstall leaves a foreign single-pack (v1) lockfile untouched", async () => {
    const project = await tempDir("agentpack-lockv2-proj-");
    await installPack(project, A);
    // Downgrade the on-disk lockfile to v1 and hand it to a DIFFERENT pack id
    // — the legacy last-install-wins state where A's entry was already lost.
    const doc = (await readLockDoc(project))!;
    const foreign = lockfileEntryAsV1({
      ...doc.packs[A.id]!,
      packId: "fixture.someone-else",
    });
    const lockPath = path.join(project, "AGENTPACK.lock");
    const foreignBytes = serializeLockfile(foreign);
    await fs.writeFile(lockPath, foreignBytes, "utf8");

    const r = await uninstall({ packId: A.id, projectRoot: project });
    expect(r.lockfile).toBe("not-tracked");
    expect(await fs.readFile(lockPath, "utf8")).toBe(foreignBytes);
  });
});

describe("v1 → v2 on-disk migration", () => {
  /** Install A, then rewrite AGENTPACK.lock to the exact v1 bytes an older CLI wrote. */
  async function projectWithV1Lock(): Promise<{ project: string; v1Bytes: string }> {
    const project = await tempDir("agentpack-lockv2-mig-");
    await installPack(project, A);
    const doc = (await readLockDoc(project))!;
    const v1Bytes = serializeLockfile(lockfileEntryAsV1(doc.packs[A.id]!));
    await fs.writeFile(path.join(project, "AGENTPACK.lock"), v1Bytes, "utf8");
    return { project, v1Bytes };
  }

  it("installing a second pack upgrades to v2 holding BOTH packs, v1 entry preserved exactly", async () => {
    const { project, v1Bytes } = await projectWithV1Lock();
    await installPack(project, B);
    const doc = await readLockDoc(project);
    expect(doc!.lockfileVersion).toBe(2);
    expect(Object.keys(doc!.packs).sort()).toEqual([A.id, B.id]);
    // The migrated entry is meaning-equivalent to the original v1 document:
    // rendering it back as standalone v1 reproduces the exact bytes.
    expect(serializeLockfile(lockfileEntryAsV1(doc!.packs[A.id]!))).toBe(v1Bytes);
  });

  it("verify of the original pack is clean with a v1 lockfile on disk and after the v2 upgrade", async () => {
    const { project } = await projectWithV1Lock();
    const beforeUpgrade = await verifyInstall({ packId: A.id, projectRoot: project });
    expect(beforeUpgrade.clean, JSON.stringify(beforeUpgrade.drift)).toBe(true);
    await installPack(project, B);
    const afterUpgrade = await verifyInstall({ packId: A.id, projectRoot: project });
    expect(afterUpgrade.clean, JSON.stringify(afterUpgrade.drift)).toBe(true);
  });

  it("core update of the original pack works from a v1 lockfile and writes v2", async () => {
    const { project } = await projectWithV1Lock();
    const v2Dir = await tempDir("agentpack-lockv2-upd-");
    await writePack(v2Dir, {
      ...A,
      version: "0.2.0",
      instructionBody: "# House of alpha, v2\n",
    });
    const newPlan = await planInstall({
      source: v2Dir,
      target: "claude-code",
      projectRoot: project,
      generator: GEN,
    });
    const ws = await resolveAgentpackPaths(project);
    const prior = await readInstallManifest(ws, A.id);
    const update = await planUpdate({ newPlan, priorManifest: prior });
    await applyUpdate({ update, actor: { type: "cli", id: "test" } });

    const doc = await readLockDoc(project);
    expect(doc!.lockfileVersion).toBe(2);
    expect(doc!.packs[A.id]?.packVersion).toBe("0.2.0");
    const r = await verifyInstall({ packId: A.id, projectRoot: project });
    expect(r.clean, JSON.stringify(r.drift)).toBe(true);
  });

  it("uninstall of the original pack works from a v1 lockfile (file removed with last pack)", async () => {
    const { project } = await projectWithV1Lock();
    const r = await uninstall({ packId: A.id, projectRoot: project });
    expect(r.lockfile).toBe("file-removed");
    expect(await readLockDoc(project)).toBeNull();
  });

  it("migrated entry survives with byte-equivalent meaning: manifest lockfileChecksum recorded under v1 still matches", async () => {
    const { project } = await projectWithV1Lock();
    const ws = await resolveAgentpackPaths(project);
    const manifest = await readInstallManifest(ws, A.id);
    await installPack(project, B);
    const doc = await readLockDoc(project);
    const entry = doc!.packs[A.id]!;
    const { lockfileEntryChecksum } = await import("../src/install/lockfile.js");
    expect(lockfileEntryChecksum(entry)).toBe(manifest.lockfileChecksum);
  });
});
