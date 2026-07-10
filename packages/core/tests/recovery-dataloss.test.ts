import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { planInstall, applyInstall, resolveAgentpackPaths } from "../src/install/index.js";
import { recoverIncomplete } from "../src/install/recovery.js";
import { readHistory, sealEntry } from "../src/install/history.js";

const EXAMPLE_PACK = path.resolve(__dirname, "../../../examples/pr-quality");
const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

async function tempProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-dataloss-test-"));
}

async function dropLastHistoryEntry(projectRoot: string): Promise<void> {
  const ws = await resolveAgentpackPaths(projectRoot);
  const raw = await fs.readFile(ws.historyFile, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  lines.pop();
  await fs.writeFile(ws.historyFile, lines.join("\n") + "\n", "utf8");
}

async function mutateBeginEntry(
  ws: { historyFile: string },
  fn: (begin: Record<string, unknown>) => void,
): Promise<void> {
  const raw = await fs.readFile(ws.historyFile, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const begin = entries.find((e) => e.action === "install_begin");
  if (!begin) throw new Error("no install_begin entry found");
  fn(begin);
  // Re-seal every entry so the hash chain stays valid — `recoverIncomplete`
  // refuses a broken chain (a forged/committed history must not drive the
  // sweep). Deleting the new fields then re-sealing faithfully emulates an
  // entry a pre-field CLI would have written and sealed.
  await fs.writeFile(
    ws.historyFile,
    entries.map((e) => JSON.stringify(sealEntry(e as never))).join("\n") + "\n",
    "utf8",
  );
}

describe("Finding 1 — partial/corrupt CREATED files removed on rollback", () => {
  it("removes a created file whose content was partially written (hash mismatch) and does not leave it behind", async () => {
    const dir = await tempProject();
    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    // AGENTS.md is CREATED (no pre-existing user file in a fresh temp project).
    expect(plan.created.some((f) => f.path === "AGENTS.md")).toBe(true);

    await applyInstall({ plan, actor: { type: "cli" } });

    // Crash window: commit row gone, manifest gone, files on disk — forces a
    // roll back (manifest missing).
    await dropLastHistoryEntry(dir);
    const ws = await resolveAgentpackPaths(dir);
    await fs.rm(path.join(ws.installedDir, "agentpack.pr-quality.json"));

    // Simulate a PARTIAL/corrupt write of the created file: its content no
    // longer matches plannedFiles[].sha256. The old roll-back logic only
    // unlinked files whose hash MATCHED, so this corrupt created file would be
    // left on disk forever.
    await fs.writeFile(path.join(dir, "AGENTS.md"), "PARTIALLY WRITTEN GARBAGE", "utf8");

    const result = await recoverIncomplete(dir);
    expect(result.rolledBack.length).toBe(1);

    // The corrupt, AgentPack-created file MUST be gone.
    await expect(fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("never deletes a pre-existing user file that was only overwritten (modify), even with mismatched hash", async () => {
    const dir = await tempProject();
    const userContent = "# user-owned AGENTS.md\nprecious\n";
    await fs.writeFile(path.join(dir, "AGENTS.md"), userContent, "utf8");

    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    // Pre-existing file → modified, not created.
    expect(plan.modified.some((f) => f.path === "AGENTS.md")).toBe(true);

    await applyInstall({ plan, force: true, actor: { type: "cli" } });

    await dropLastHistoryEntry(dir);
    const ws = await resolveAgentpackPaths(dir);
    await fs.rm(path.join(ws.installedDir, "agentpack.pr-quality.json"));

    const result = await recoverIncomplete(dir);
    expect(result.rolledBack.length).toBe(1);
    // The user's original content is restored — never unconditionally deleted.
    const after = await fs.readFile(path.join(dir, "AGENTS.md"), "utf8");
    expect(after).toBe(userContent);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("Finding 2 — swallowed backup-restore failure must NOT report success", () => {
  it("classifies recovery as unresolved (not rolledBack-success) when a required backup cannot be restored", async () => {
    const dir = await tempProject();
    const userContent = "# user-owned AGENTS.md the install overwrote\n";
    await fs.writeFile(path.join(dir, "AGENTS.md"), userContent, "utf8");

    const plan = await planInstall({
      source: EXAMPLE_PACK,
      target: "generic",
      profile: "safe",
      projectRoot: dir,
      generator: GEN,
    });
    expect(plan.modified.some((f) => f.path === "AGENTS.md")).toBe(true);

    await applyInstall({ plan, force: true, actor: { type: "cli" } });

    await dropLastHistoryEntry(dir);
    const ws = await resolveAgentpackPaths(dir);
    await fs.rm(path.join(ws.installedDir, "agentpack.pr-quality.json"));

    // Destroy the backup directory so the user's original CANNOT be restored.
    await fs.rm(ws.backupsDir, { recursive: true, force: true });

    const result = await recoverIncomplete(dir);
    // It must NOT be recorded as a successful rollback.
    expect(result.rolledBack.length).toBe(0);
    expect(result.unresolved.length).toBe(1);

    // The last history row must NOT be a success rollback recovery.
    const entries = await readHistory(ws);
    const last = entries.at(-1);
    if (last?.action === "install_rollback_recovery") {
      expect(last.result).not.toBe("success");
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("backward compatibility — old install_begin without new fields", () => {
  it("recovers safely (rolls back) when the begin entry lacks createdPaths/requiredBackups", async () => {
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

    // Strip the new fields to emulate an entry written by an older CLI.
    await mutateBeginEntry(ws, (begin) => {
      delete begin.createdPaths;
      delete begin.requiredBackups;
    });

    const result = await recoverIncomplete(dir);
    expect(result.found).toBe(1);
    // Degrades to the legacy hash-match unlink behavior — does not crash and
    // still rolls back the clean created file.
    expect(result.rolledBack.length).toBe(1);
    await expect(fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
