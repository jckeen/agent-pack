import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  recordHistory,
  readHistory,
  verifyChain,
  sealEntry,
  newHistoryId,
} from "../src/install/history.js";
import { resolveWorkgraphPaths } from "../src/install/paths.js";
import type { HistoryEntryV1 } from "../src/install/types.js";

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-history-test-"));
}

function makePartial(
  overrides: Partial<Omit<HistoryEntryV1, "previousEntryId" | "entryChecksum">> = {},
): Omit<HistoryEntryV1, "previousEntryId" | "entryChecksum"> {
  return {
    id: newHistoryId(),
    action: "install_commit",
    timestamp: new Date().toISOString(),
    packId: "workgraph.test",
    packVersion: "0.1.0",
    target: "generic",
    profile: "safe",
    actor: { type: "cli" },
    result: "success",
    ...overrides,
  };
}

describe("newHistoryId", () => {
  it("returns sortable id strings", () => {
    const a = newHistoryId(1000);
    const b = newHistoryId(2000);
    expect(a < b).toBe(true);
    expect(a).toMatch(/^[0-9a-f]{26}$/);
  });
});

describe("sealEntry", () => {
  it("populates entryChecksum deterministically", () => {
    const e1 = sealEntry({
      ...makePartial({ id: "fixed-id" }),
      previousEntryId: "",
      entryChecksum: "",
    });
    const e2 = sealEntry({
      ...makePartial({ id: "fixed-id" }),
      previousEntryId: "",
      entryChecksum: "",
      timestamp: e1.timestamp,
    });
    expect(e1.entryChecksum).toBe(e2.entryChecksum);
    expect(e1.entryChecksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("differs when content differs", () => {
    const a = sealEntry({
      ...makePartial({ id: "id-A" }),
      previousEntryId: "",
      entryChecksum: "",
    });
    const b = sealEntry({
      ...makePartial({ id: "id-B" }),
      previousEntryId: "",
      entryChecksum: "",
      timestamp: a.timestamp,
    });
    expect(a.entryChecksum).not.toBe(b.entryChecksum);
  });
});

describe("recordHistory + readHistory", () => {
  it("appends entries with previousEntryId pointing to the last entry", async () => {
    const dir = await tempDir();
    const ws = await resolveWorkgraphPaths(dir);
    const e1 = await recordHistory(ws, makePartial());
    const e2 = await recordHistory(ws, makePartial());
    const all = await readHistory(ws);
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe(e1.id);
    expect(all[1]?.id).toBe(e2.id);
    expect(all[0]?.previousEntryId).toBe("");
    expect(all[1]?.previousEntryId).toBe(e1.id);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns [] when no history file exists", async () => {
    const dir = await tempDir();
    const ws = await resolveWorkgraphPaths(dir);
    expect(await readHistory(ws)).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("verifyChain", () => {
  it("passes on a well-formed chain", async () => {
    const dir = await tempDir();
    const ws = await resolveWorkgraphPaths(dir);
    await recordHistory(ws, makePartial());
    await recordHistory(ws, makePartial());
    await recordHistory(ws, makePartial({ action: "uninstall" }));
    const all = await readHistory(ws);
    expect(verifyChain(all)).toEqual({ ok: true });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fails when previousEntryId is broken", async () => {
    const dir = await tempDir();
    const ws = await resolveWorkgraphPaths(dir);
    await recordHistory(ws, makePartial());
    await recordHistory(ws, makePartial());

    // Tamper: rewrite the file with the second entry's previousEntryId
    // pointing to a bogus id.
    const lines = (await fs.readFile(ws.historyFile, "utf8"))
      .split("\n")
      .filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l)) as HistoryEntryV1[];
    if (entries[1]) entries[1].previousEntryId = "bogus";
    await fs.writeFile(ws.historyFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const all = await readHistory(ws);
    const r = verifyChain(all);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.brokeAt).toBe(1);
      expect(r.reason).toMatch(/previousEntryId/);
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fails when entryChecksum is wrong", async () => {
    const dir = await tempDir();
    const ws = await resolveWorkgraphPaths(dir);
    await recordHistory(ws, makePartial());
    const lines = (await fs.readFile(ws.historyFile, "utf8"))
      .split("\n")
      .filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l)) as HistoryEntryV1[];
    if (entries[0]) entries[0].entryChecksum = "f".repeat(64);
    await fs.writeFile(ws.historyFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const all = await readHistory(ws);
    const r = verifyChain(all);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/entryChecksum mismatch/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("history concurrency", () => {
  it("serializes parallel recordHistory writes (chain remains intact)", async () => {
    const dir = await tempDir();
    const ws = await resolveWorkgraphPaths(dir);
    await Promise.all([
      recordHistory(ws, makePartial({ packId: "a" })),
      recordHistory(ws, makePartial({ packId: "b" })),
      recordHistory(ws, makePartial({ packId: "c" })),
      recordHistory(ws, makePartial({ packId: "d" })),
      recordHistory(ws, makePartial({ packId: "e" })),
    ]);
    const all = await readHistory(ws);
    expect(all).toHaveLength(5);
    expect(verifyChain(all)).toEqual({ ok: true });
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("history file detection", () => {
  it("throws on malformed line", async () => {
    const dir = await tempDir();
    const ws = await resolveWorkgraphPaths(dir);
    await fs.mkdir(ws.workgraphDir, { recursive: true });
    await fs.writeFile(ws.historyFile, "not-json\n");
    await expect(readHistory(ws)).rejects.toThrow(/not valid JSON/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
