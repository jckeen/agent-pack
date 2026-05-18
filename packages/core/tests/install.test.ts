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
  resolveWorkgraphPaths,
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
    expect(plan.packId).toBe("workgraph.pr-quality");
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
    expect(lock.packId).toBe("workgraph.pr-quality");
    const ws = await resolveWorkgraphPaths(dir);
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
    const ws = await resolveWorkgraphPaths(dir);
    const manifest = await readInstallManifest(ws, plan.packId);
    expect(manifest.backups.length).toBeGreaterThan(0);
    const backupRel = manifest.backups[0]?.backupPath;
    expect(backupRel?.startsWith(".workgraph/backups/")).toBe(true);
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
    const ws = await resolveWorkgraphPaths(dir);
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
    // Ensure .workgraph exists so resolveWorkgraphPaths succeeds.
    await fs.mkdir(path.join(dir, ".workgraph"), { recursive: true });
    await expect(uninstall({ packId: "nope", projectRoot: dir })).rejects.toThrow(/No install manifest/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
