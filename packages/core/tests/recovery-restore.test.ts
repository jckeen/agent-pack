import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { planInstall, applyInstall, resolveAgentpackPaths } from "../src/install/index.js";
import { recoverIncomplete } from "../src/install/recovery.js";
import { readHistory } from "../src/install/history.js";

const EXAMPLE_PACK = path.resolve(__dirname, "../../../examples/pr-quality");
const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

async function tempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-recovery-test-"));
}

/**
 * Truncate history.jsonl so the LAST entry (the install_commit row) is gone,
 * simulating a crash between file writes and the commit row. The forward
 * hash chain stays valid because we only drop the tail.
 */
async function dropLastHistoryEntry(projectRoot: string): Promise<void> {
  const ws = await resolveAgentpackPaths(projectRoot);
  const raw = await fs.readFile(ws.historyFile, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  lines.pop();
  await fs.writeFile(ws.historyFile, lines.join("\n") + "\n", "utf8");
}

describe("applyInstall failure cleanup (codex P0-1)", () => {
  it("restores backed-up user files instead of deleting them when install fails mid-apply", async () => {
    const dir = await tempProject();
    const userContent = "# user-owned file\n\nprecious content\n";
    await fs.writeFile(path.join(dir, "AGENTS.md"), userContent, "utf8");

    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    // AGENTS.md merges with the user file: classified modified, backed up.
    expect(plan.modified.some((f) => f.path === "AGENTS.md")).toBe(true);

    // Sabotage step 4 (AGENTPACK.lock write): a non-empty directory at the
    // lockfile path makes the atomic rename fail AFTER project files are
    // written, exercising the catch path.
    await fs.mkdir(path.join(dir, "AGENTPACK.lock", "block"), { recursive: true });

    await expect(applyInstall({ plan, actor: { type: "cli" } })).rejects.toThrow();

    // The user's file must be RESTORED, not deleted.
    const after = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(after).toBe(userContent);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("still removes created files on failure (no half-install left behind)", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await fs.mkdir(path.join(dir, "AGENTPACK.lock", "block"), { recursive: true });
    await expect(applyInstall({ plan, actor: { type: "cli" } })).rejects.toThrow();
    await expect(fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("recovery sweep (codex P0-4)", () => {
  it("does NOT roll forward a dangling begin when the install manifest is missing", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan, actor: { type: "cli" } });

    // Simulate a crash window: commit row gone, manifest gone, files on disk.
    await dropLastHistoryEntry(dir);
    const ws = await resolveAgentpackPaths(dir);
    await fs.rm(path.join(ws.installedDir, "agentpack.pr-quality.json"));

    const result = await recoverIncomplete(dir);
    expect(result.found).toBe(1);
    // Rolling forward here would mark the install successful while verify/
    // uninstall/rollback cannot find it. It must be rolled back instead.
    expect(result.recovered.length).toBe(0);
    expect(result.rolledBack.length).toBe(1);

    // Staged files were removed.
    await expect(fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).rejects.toThrow();

    const entries = await readHistory(ws);
    expect(entries.at(-1)?.action).toBe("install_rollback_recovery");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rolls forward when manifest exists and files are clean", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan, actor: { type: "cli" } });
    await dropLastHistoryEntry(dir); // commit row gone, manifest still present

    const result = await recoverIncomplete(dir);
    expect(result.found).toBe(1);
    expect(result.recovered.length).toBe(1);
    expect(result.rolledBack.length).toBe(0);
    // Files stay.
    await expect(fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).resolves.toContain(
      "AGENTPACK",
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("restores backed-up user files when rolling back a forced install", async () => {
    const dir = await tempProject();
    const userContent = "# user-owned AGENTS.md\n";
    await fs.writeFile(path.join(dir, "AGENTS.md"), userContent, "utf8");

    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan, force: true, actor: { type: "cli" } });

    // Crash window: no commit row, no manifest.
    await dropLastHistoryEntry(dir);
    const ws = await resolveAgentpackPaths(dir);
    await fs.rm(path.join(ws.installedDir, "agentpack.pr-quality.json"));

    const result = await recoverIncomplete(dir);
    expect(result.rolledBack.length).toBe(1);

    // The user's pre-install file is back.
    const after = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(after).toBe(userContent);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("recovery restoreBackups edge cases", () => {
  it("does not clobber a file the user recreated after the crash", async () => {
    const dir = await tempProject();
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# original user file\n", "utf8");

    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan, actor: { type: "cli" } });

    // Crash window: no commit row, no manifest.
    await dropLastHistoryEntry(dir);
    const ws = await resolveAgentpackPaths(dir);
    await fs.rm(path.join(ws.installedDir, "agentpack.pr-quality.json"));

    // User recreates AGENTS.md with NEW content before recovery runs. The
    // staged-file unlink pass skips it (hash mismatch) and the backup
    // restore must NOT overwrite it.
    const userNew = "# user recreated this after the crash\n";
    await fs.writeFile(path.join(dir, "AGENTS.md"), userNew, "utf8");

    const result = await recoverIncomplete(dir);
    expect(result.rolledBack.length).toBe(1);
    const after = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(after).toBe(userNew);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a begin entry with a malformed backupDir does not block the sweep", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    await applyInstall({ plan, actor: { type: "cli" } });
    await dropLastHistoryEntry(dir);
    const ws = await resolveAgentpackPaths(dir);
    await fs.rm(path.join(ws.installedDir, "agentpack.pr-quality.json"));

    // Corrupt the begin entry's backupDir to an escaping path. The sweep
    // must still roll back (best-effort restore refuses to act, silently).
    const raw = await fs.readFile(ws.historyFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const entries = lines.map((l) => JSON.parse(l));
    const begin = entries.find((e) => e.action === "install_begin");
    begin.backupDir = "../outside-project";
    // Re-seal is unnecessary for this test path — recovery reads entries
    // leniently; write the mutated line back.
    await fs.writeFile(
      ws.historyFile,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );

    const result = await recoverIncomplete(dir);
    expect(result.rolledBack.length).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
