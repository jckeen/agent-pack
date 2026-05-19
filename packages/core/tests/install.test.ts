import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  planInstall,
  applyInstall,
  verifyInstall,
  uninstall,
  readHistory,
  verifyChain,
  parseLockfile,
  resolveAgentpackPaths,
  readInstallManifest,
} from "../src/install/index.js";

const EXAMPLE_PACK = path.resolve(__dirname, "../../../examples/pr-quality");
const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

async function tempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-install-test-"));
}

describe("planInstall", () => {
  it("classifies a clean install as all-created", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    expect(plan.created.length).toBeGreaterThan(0);
    expect(plan.modified.length).toBe(0);
    expect(plan.conflicts.length).toBe(0);
    expect(plan.packId).toBe("agentpack.pr-quality");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("flags pre-existing non-marker file as conflict", async () => {
    const dir = await tempProject();
    // Write a user-owned AGENTS.md without the marker.
    await fs.writeFile(path.join(dir, "AGENTS.md"), "user content\n");
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    expect(plan.conflicts.length).toBeGreaterThan(0);
    const c = plan.conflicts.find((c) => c.file.path === "AGENTS.md");
    expect(c?.reason).toBe("no-marker-existing-content");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("classifies a re-install with same bytes as `unchanged`", async () => {
    const dir = await tempProject();
    await applyInstall({
      plan: await planInstall({
        source: EXAMPLE_PACK,
        target: "generic",
        profile: "safe",
        projectRoot: dir,
        generator: GEN,
      }),
      actor: { type: "cli" },
    });
    const plan2 = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    expect(plan2.unchanged.length).toBeGreaterThan(0);
    expect(plan2.created.length).toBe(0);
    expect(plan2.conflicts.length).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("emits a deterministic lockfile", async () => {
    const a = await tempProject();
    const b = await tempProject();
    const planA = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: a,
      generator: GEN,
    });
    const planB = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: b,
      generator: GEN,
    });
    expect(planA.lockfile).toEqual(planB.lockfile);
    await fs.rm(a, { recursive: true, force: true });
    await fs.rm(b, { recursive: true, force: true });
  });

  it("refuses to escape projectRoot via symlink", async () => {
    const dir = await tempProject();
    // Replace a target subdir with a symlink to /tmp.
    await fs.mkdir(path.join(dir, "skills"), { recursive: true });
    await fs.rm(path.join(dir, "skills"), { recursive: true });
    await fs.symlink("/tmp", path.join(dir, "skills"));
    await expect(
      planInstall({
        source: EXAMPLE_PACK,
        target: "generic",
        profile: "safe",
        projectRoot: dir,
        generator: GEN,
      }),
    ).rejects.toThrow(/outside project root/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("applyInstall", () => {
  it("writes lockfile, manifest, history begin+commit", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan });
    const lock = parseLockfile(await fs.readFile(path.join(dir, "AGENTPACK.lock"), "utf8"));
    expect(lock.packId).toBe("agentpack.pr-quality");
    const ws = await resolveAgentpackPaths(dir);
    const manifest = await readInstallManifest(ws, plan.packId);
    expect(manifest.created.length).toBeGreaterThan(0);
    expect(manifest.rollbackable).toBe(true);
    const history = await readHistory(ws);
    const begins = history.filter((e) => e.action === "install_begin");
    const commits = history.filter((e) => e.action === "install_commit");
    expect(begins).toHaveLength(1);
    expect(commits).toHaveLength(1);
    expect(verifyChain(history)).toEqual({ ok: true });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("two installs into separate clean dirs produce byte-identical AGENTPACK.lock", async () => {
    const a = await tempProject();
    const b = await tempProject();
    for (const dir of [a, b]) {
      const plan = await planInstall({
        source: EXAMPLE_PACK,
        target: "generic",
        profile: "safe",
        projectRoot: dir,
        generator: GEN,
      });
      await applyInstall({ plan });
    }
    const aLock = await fs.readFile(path.join(a, "AGENTPACK.lock"), "utf8");
    const bLock = await fs.readFile(path.join(b, "AGENTPACK.lock"), "utf8");
    expect(aLock).toBe(bLock);
    await fs.rm(a, { recursive: true, force: true });
    await fs.rm(b, { recursive: true, force: true });
  });

  it("refuses conflicts without --force", async () => {
    const dir = await tempProject();
    await fs.writeFile(path.join(dir, "AGENTS.md"), "user content\n");
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await expect(applyInstall({ plan })).rejects.toThrow(/conflict/i);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("backs up overwritten files when --force", async () => {
    const dir = await tempProject();
    await fs.writeFile(path.join(dir, "AGENTS.md"), "user content\n");
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan, force: true });
    const ws = await resolveAgentpackPaths(dir);
    const manifest = await readInstallManifest(ws, plan.packId);
    expect(manifest.backups.length).toBeGreaterThan(0);
    const backupRel = manifest.backups[0]?.backupPath;
    expect(backupRel?.startsWith(".agentpack/backups/")).toBe(true);
    const backupAbs = path.join(dir, backupRel ?? "");
    expect(await fs.readFile(backupAbs, "utf8")).toBe("user content\n");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("verifyInstall", () => {
  it("reports clean after fresh install", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan });
    const r = await verifyInstall({ packId: plan.packId, projectRoot: dir });
    expect(r.clean).toBe(true);
    expect(r.drift).toEqual([]);
    expect(r.missing).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("detects drift after manual edit", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan });
    await fs.appendFile(path.join(dir, "AGENTS.md"), "\ntampered\n");
    const r = await verifyInstall({ packId: plan.packId, projectRoot: dir });
    expect(r.clean).toBe(false);
    expect(r.drift.some((d) => d.path === "AGENTS.md")).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("detects missing files", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan });
    await fs.unlink(path.join(dir, "AGENTS.md"));
    const r = await verifyInstall({ packId: plan.packId, projectRoot: dir });
    expect(r.missing).toContain("AGENTS.md");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("--chain ok on healthy history", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan });
    const r = await verifyInstall({ packId: plan.packId, projectRoot: dir, checkChain: true });
    expect(r.chainOk).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("uninstall", () => {
  it("removes all created files and deletes manifest", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan });
    const result = await uninstall({ packId: plan.packId, projectRoot: dir });
    expect(result.removed.length).toBeGreaterThan(0);
    expect(result.conflicts).toHaveLength(0);
    // Manifest should be gone.
    const ws = await resolveAgentpackPaths(dir);
    await expect(readInstallManifest(ws, plan.packId)).rejects.toThrow(/No install manifest/);
    // Files should be gone.
    await expect(fs.stat(path.join(dir, "AGENTS.md"))).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses without --force when user has edited a created file", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan });
    await fs.appendFile(path.join(dir, "AGENTS.md"), "\nuser change\n");
    await expect(uninstall({ packId: plan.packId, projectRoot: dir })).rejects.toThrow(/conflict/i);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("roundtrip restores backups bit-identically with --force", async () => {
    const dir = await tempProject();
    const original = "original user content\nline 2\n";
    await fs.writeFile(path.join(dir, "AGENTS.md"), original);
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan, force: true });
    await uninstall({ packId: plan.packId, projectRoot: dir, force: true });
    const restored = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(restored).toBe(original);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("missing manifest throws InstallManifestNotFoundError", async () => {
    const dir = await tempProject();
    // Ensure .agentpack exists so resolveAgentpackPaths succeeds.
    await fs.mkdir(path.join(dir, ".agentpack"), { recursive: true });
    await expect(uninstall({ packId: "nope", projectRoot: dir })).rejects.toThrow(/No install manifest/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("applyInstall re-claim semantics (iter-5 codex P1)", () => {
  it("first install does NOT adopt a user-owned bit-identical file as `created`", async () => {
    const dir = await tempProject();
    // Pre-stage a file that will happen to be byte-identical with the planned
    // output. The planner classifies it as `unchanged`. Because there is no
    // prior install manifest, the new manifest must NOT claim ownership.
    const firstPlan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    // Find a `created` file from the planner; mirror its content onto disk
    // BEFORE applying — that flips it from `created` to `unchanged` in a
    // second plan, simulating the "user happens to have identical content"
    // scenario.
    const target = firstPlan.created.find((f) => f.path.startsWith("skills/"));
    if (!target) throw new Error("expected a skills/* output in pr-quality export");
    const userOwnedPath = path.join(dir, target.path);
    await fs.mkdir(path.dirname(userOwnedPath), { recursive: true });
    const userContent = target.content.endsWith("\n")
      ? target.content
      : `${target.content}\n`;
    await fs.writeFile(userOwnedPath, userContent, "utf8");
    // Re-plan: target should now classify as unchanged.
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    expect(plan.unchanged.some((f) => f.path === target.path)).toBe(true);
    // First install (no prior manifest exists) — must not adopt the unchanged
    // path as `created`.
    const result = await applyInstall({ plan });
    const ws = await resolveAgentpackPaths(dir);
    const manifest = await readInstallManifest(ws, plan.packId);
    expect(manifest.created.some((c) => c.path === target.path)).toBe(false);
    expect(manifest.modified.some((m) => m.path === target.path)).toBe(false);
    expect(result.written.length).toBeGreaterThan(0);
    // Sanity: uninstall does NOT touch the user-owned file.
    await uninstall({ packId: plan.packId, projectRoot: dir });
    await expect(fs.access(userOwnedPath)).resolves.toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("--force reinstall re-claims unchanged files that prior manifest already owned (orphan fix)", async () => {
    const dir = await tempProject();
    // First install — produces a manifest with N created files.
    const plan1 = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan: plan1 });
    const ws = await resolveAgentpackPaths(dir);
    const manifest1 = await readInstallManifest(ws, plan1.packId);
    expect(manifest1.created.length).toBeGreaterThan(0);
    // Tamper one file so plan #2 classifies most paths as `unchanged` and
    // one as `modify`. Without the re-claim fix, the new manifest would only
    // track the modified path; the other previously-created files would
    // become orphans.
    const toTamper = manifest1.created[0]!.path;
    const tamperAbs = path.join(dir, toTamper);
    const originalContent = await fs.readFile(tamperAbs, "utf8");
    await fs.writeFile(tamperAbs, `${originalContent}// tampered\n`, "utf8");
    // Second install with --force.
    const plan2 = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan: plan2, force: true });
    const manifest2 = await readInstallManifest(ws, plan1.packId);
    // The new manifest must still cover EVERY path that the first manifest
    // covered (either in created[] or modified[]).
    for (const c of manifest1.created) {
      const stillOwned =
        manifest2.created.some((x) => x.path === c.path) ||
        manifest2.modified.some((x) => x.path === c.path);
      expect(stillOwned).toBe(true);
    }
    // Uninstall removes every path that was in created[] of manifest2 (the
    // re-claimed unchanged files) and restores backups for paths in
    // modified[]. The tampered path lives in modified[] now (backup carries
    // the tampered bytes), so it persists; every other previously-tracked
    // path is gone.
    await uninstall({ packId: plan1.packId, projectRoot: dir, force: true });
    for (const c of manifest1.created) {
      if (c.path === toTamper) continue; // lives in modified[]; restored from backup
      await expect(fs.access(path.join(dir, c.path))).rejects.toThrow();
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("preserves prior modified+backup state across re-install (codex P1)", async () => {
    const dir = await tempProject();
    // T1: user owns AGENTS.md with their own content.
    const userOriginal = "USER OWNED ORIGINAL\nline 2\n";
    await fs.writeFile(path.join(dir, "AGENTS.md"), userOriginal, "utf8");
    // T2: install --force → AGENTS.md goes into modified[], backup written.
    const plan1 = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan: plan1, force: true });
    const ws = await resolveAgentpackPaths(dir);
    const m1 = await readInstallManifest(ws, plan1.packId);
    expect(m1.modified.some((m) => m.path === "AGENTS.md")).toBe(true);
    expect(m1.backups.some((b) => b.original === "AGENTS.md")).toBe(true);
    // T3: re-install --force; everything bit-identical now. AGENTS.md must
    // STAY in modified[] and the backup record must carry forward, otherwise
    // uninstall would delete the file instead of restoring user content.
    const plan2 = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan: plan2, force: true });
    const m2 = await readInstallManifest(ws, plan1.packId);
    expect(m2.modified.some((m) => m.path === "AGENTS.md")).toBe(true);
    expect(m2.created.some((c) => c.path === "AGENTS.md")).toBe(false);
    expect(m2.backups.some((b) => b.original === "AGENTS.md")).toBe(true);
    // T4: uninstall → user content restored.
    await uninstall({ packId: plan1.packId, projectRoot: dir, force: true });
    const restored = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(restored).toBe(userOriginal);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
