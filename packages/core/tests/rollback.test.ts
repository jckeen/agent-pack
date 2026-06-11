import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  planInstall,
  applyInstall,
  uninstall,
  rollback,
  recoverIncomplete,
  readHistory,
  recordHistory,
  newHistoryId,
  resolveAgentpackPaths,
} from "../src/install/index.js";

const EXAMPLE_PACK = path.resolve(__dirname, "../../../examples/pr-quality");
const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

async function tempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-rollback-test-"));
}

describe("rollback", () => {
  it("undoes the most recent install when called without --to", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan });
    const r = await rollback({ projectRoot: dir });
    expect(r.undone.length).toBe(1);
    expect(r.uninstalledPacks).toContain(plan.packId);
    // The install manifest should be gone.
    const ws = await resolveAgentpackPaths(dir);
    const installedDir = ws.installedDir;
    const entries = await fs.readdir(installedDir).catch(() => []);
    expect(entries).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses to roll back past a superseded install without --cascade", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    const first = await applyInstall({ plan });
    // Uninstall + reinstall = supersession of the first commit.
    await uninstall({ packId: plan.packId, projectRoot: dir });
    const plan2 = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan: plan2 });
    // Try to roll back to BEFORE the first install.
    await expect(rollback({ projectRoot: dir, to: first.commitEntry.previousEntryId })).rejects.toThrow(/superseded|already/i);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("history is appended with action=rollback", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan });
    await rollback({ projectRoot: dir });
    const ws = await resolveAgentpackPaths(dir);
    const history = await readHistory(ws);
    expect(history.at(-1)?.action).toBe("rollback");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("recoverIncomplete", () => {
  it("rolls back a dangling install_begin where no files exist", async () => {
    const dir = await tempProject();
    const ws = await resolveAgentpackPaths(dir);
    // Write a begin entry with plannedFiles that don't exist on disk.
    await recordHistory(ws, {
      id: newHistoryId(),
      action: "install_begin",
      timestamp: new Date().toISOString(),
      packId: "fake.pack",
      packVersion: "0.0.1",
      target: "generic",
      profile: "safe",
      plannedFiles: [{ path: "MISSING.md", sha256: "a".repeat(64) }],
      actor: { type: "cli" },
      result: "partial",
    });
    const r = await recoverIncomplete(dir);
    expect(r.found).toBe(1);
    expect(r.rolledBack.length).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is idempotent — re-running on clean state is a no-op", async () => {
    const dir = await tempProject();
    await fs.mkdir(path.join(dir, ".agentpack"), { recursive: true });
    const a = await recoverIncomplete(dir);
    const b = await recoverIncomplete(dir);
    expect(a.found).toBe(0);
    expect(b.found).toBe(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rolls BACK a clean-files dangling begin that has no install manifest (codex P0-4)", async () => {
    const dir = await tempProject();
    // First do a real install to get all the right files on disk.
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan });
    // Then synthesize a dangling install_begin for a SECOND fake pack whose
    // planned files happen to be ones we actually have on disk: AGENTS.md.
    const ws = await resolveAgentpackPaths(dir);
    const agentsHash = (await readHistory(ws))
      .find((e) => e.action === "install_begin")
      ?.plannedFiles?.find((f) => f.path === "AGENTS.md")?.sha256;
    expect(agentsHash).toBeTruthy();
    await recordHistory(ws, {
      id: newHistoryId(),
      action: "install_begin",
      timestamp: new Date().toISOString(),
      packId: "synthetic.dangling",
      packVersion: "0.0.1",
      target: "generic",
      profile: "safe",
      plannedFiles: [{ path: "AGENTS.md", sha256: agentsHash! }],
      actor: { type: "cli" },
      result: "partial",
    });
    const r = await recoverIncomplete(dir);
    expect(r.found).toBe(1);
    // Files-on-disk alone is not a durable install: synthetic.dangling has no
    // install manifest, so rolling forward would record a "successful" install
    // that verify/uninstall/rollback cannot find. It must roll back instead.
    expect(r.recovered.length).toBe(0);
    expect(r.rolledBack.length).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
