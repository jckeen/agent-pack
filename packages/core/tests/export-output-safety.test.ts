import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { exportPack } from "../src/exports/exportPack.js";
import { exportPlugin } from "../src/exports/exportPlugin.js";
import { exportChat } from "../src/exports/exportChat.js";
import { exportMcpb } from "../src/exports/exportMcpb.js";
import { assertNoPathConflicts } from "../src/exports/outputSafety.js";
import { foldImportInto, importClaudeMd, writeImport } from "../src/importer/index.js";
import { loadManifest } from "../src/parser/loadManifest.js";

// Issue #216: the symlink-containment and stale-outDir defects fixed in the
// Agent Plugins exporter also existed in every sibling that writes into a
// caller-chosen directory. One block per sibling.

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-out-safety-"));
}

async function exists(dir: string, rel: string): Promise<boolean> {
  return fs.lstat(path.join(dir, rel)).then(
    () => true,
    () => false,
  );
}

/** Every file under `dir`, as sorted forward-slash relative paths. */
async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(abs, entry.name), childRel);
      else out.push(childRel);
    }
  }
  await walk(dir, "");
  return out.sort();
}

describe("exportPack outDir safety", () => {
  it("refuses to write through a symlinked directory in outDir", async () => {
    const out = await tmp();
    const elsewhere = await tmp();
    await fs.symlink(elsewhere, path.join(out, ".claude"));
    await expect(
      exportPack({ source: EXAMPLE, target: "claude-code", profile: "safe", outDir: out }),
    ).rejects.toThrow(/symlink/i);
    expect(await listFiles(elsewhere)).toEqual([]);
    await fs.rm(out, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it("refuses to overwrite the target of a symlink sitting at an output file path", async () => {
    const out = await tmp();
    const elsewhere = await tmp();
    const victim = path.join(elsewhere, "victim.md");
    await fs.writeFile(victim, "untouched\n");
    await fs.symlink(victim, path.join(out, "CLAUDE.md"));
    await expect(
      exportPack({ source: EXAMPLE, target: "claude-code", profile: "safe", outDir: out }),
    ).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(victim, "utf8")).toBe("untouched\n");
    await fs.rm(out, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it("reports files a wider profile left behind instead of silently keeping them", async () => {
    const out = await tmp();
    await exportPack({
      source: EXAMPLE,
      target: "claude-code",
      profile: "full",
      outDir: out,
    });
    expect(await exists(out, ".claude/settings.json")).toBe(true);
    await fs.writeFile(path.join(out, "NOTES.md"), "mine\n");

    const result = await exportPack({
      source: EXAMPLE,
      target: "claude-code",
      profile: "safe",
      outDir: out,
    });
    expect(result.staleFiles).toContain(".claude/settings.json");
    // Only paths this pack emits are reported — never an unrelated file.
    expect(result.staleFiles).not.toContain("NOTES.md");
    expect(result.plan.warnings.join("\n")).toMatch(/\.claude\/settings\.json/);
    // A generic export target may be a live project: nothing is deleted.
    expect(await exists(out, ".claude/settings.json")).toBe(true);
    expect(await exists(out, "NOTES.md")).toBe(true);
    await fs.rm(out, { recursive: true, force: true });
  });

  it("reports nothing stale for a fresh directory", async () => {
    const out = await tmp();
    const result = await exportPack({
      source: EXAMPLE,
      target: "claude-code",
      profile: "safe",
      outDir: out,
    });
    expect(result.staleFiles).toEqual([]);
    await fs.rm(out, { recursive: true, force: true });
  });
});

describe("exportPlugin outDir safety", () => {
  it("refuses to write through a symlinked component path in outDir", async () => {
    const out = await tmp();
    const elsewhere = await tmp();
    await fs.symlink(elsewhere, path.join(out, "skills"));
    await expect(
      exportPlugin({ source: EXAMPLE, profile: "full", outDir: out }),
    ).rejects.toThrow(/symlink/i);
    expect(await listFiles(elsewhere)).toEqual([]);
    await fs.rm(out, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it("replaces managed paths so a safe re-export cannot retain full-profile hooks", async () => {
    const fresh = await tmp();
    await exportPlugin({ source: EXAMPLE, profile: "safe", outDir: fresh });

    const reused = await tmp();
    await exportPlugin({
      source: EXAMPLE,
      profile: "full",
      outDir: reused,
      marketplace: true,
    });
    expect(await exists(reused, "hooks/hooks.json")).toBe(true);
    await fs.writeFile(path.join(reused, "NOTES.md"), "mine\n");
    await exportPlugin({ source: EXAMPLE, profile: "safe", outDir: reused });

    expect(await exists(reused, "hooks/hooks.json")).toBe(false);
    expect(await exists(reused, ".mcp.json")).toBe(false);
    // Unmanaged files in the directory are left alone.
    expect(await listFiles(reused)).toEqual(
      [...(await listFiles(fresh)), "NOTES.md"].sort(),
    );
    await fs.rm(fresh, { recursive: true, force: true });
    await fs.rm(reused, { recursive: true, force: true });
  });
});

describe("exportChat outDir safety", () => {
  it("refuses to write skill ZIPs through a symlinked skills/ directory", async () => {
    const out = await tmp();
    const elsewhere = await tmp();
    await fs.symlink(elsewhere, path.join(out, "skills"));
    await expect(
      exportChat({ source: EXAMPLE, profile: "full", outDir: out }),
    ).rejects.toThrow(/symlink/i);
    expect(await listFiles(elsewhere)).toEqual([]);
    await fs.rm(out, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it("leaves a reused directory identical to a fresh export of the same selection", async () => {
    const reused = await tmp();
    const full = await exportChat({ source: EXAMPLE, profile: "full", outDir: reused });
    // Narrow to one skill: every other skill ZIP (and connectors.json) the
    // full export wrote must be gone afterwards.
    const onlyAtoms = [full.skills[0]!.atomId];
    const fresh = await tmp();
    await exportChat({ source: EXAMPLE, profile: "full", outDir: fresh, onlyAtoms });
    // Guard the premise: the full export really does write more.
    expect(full.writtenFiles.length).toBeGreaterThan((await listFiles(fresh)).length);

    await exportChat({ source: EXAMPLE, profile: "full", outDir: reused, onlyAtoms });
    expect(await listFiles(reused)).toEqual(await listFiles(fresh));
    await fs.rm(fresh, { recursive: true, force: true });
    await fs.rm(reused, { recursive: true, force: true });
  });
});

describe("exportMcpb outDir safety", () => {
  it("refuses to overwrite the target of a symlink sitting at the bundle path", async () => {
    const probe = await tmp();
    const { bundlePath } = await exportMcpb({
      source: EXAMPLE,
      profile: "full",
      outDir: probe,
    });
    const bundleName = path.basename(bundlePath);

    const out = await tmp();
    const elsewhere = await tmp();
    const victim = path.join(elsewhere, "victim.bin");
    await fs.writeFile(victim, "untouched\n");
    await fs.symlink(victim, path.join(out, bundleName));
    await expect(
      exportMcpb({ source: EXAMPLE, profile: "full", outDir: out }),
    ).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(victim, "utf8")).toBe("untouched\n");
    for (const dir of [probe, out, elsewhere]) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("import write containment", () => {
  const imported = () =>
    importClaudeMd("# T\n\n## Working Style\n\nBe concise.\n", {
      id: "acme.notes",
      name: "Notes",
    });

  it("writeImport refuses to write atom files through a symlinked atoms/ directory", async () => {
    const out = await tmp();
    const elsewhere = await tmp();
    await fs.symlink(elsewhere, path.join(out, "atoms"));
    await expect(writeImport(imported(), out)).rejects.toThrow(/symlink/i);
    expect(await listFiles(elsewhere)).toEqual([]);
    await fs.rm(out, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  it("foldImportInto never deletes files reached through a symlinked atoms/ directory", async () => {
    const pack = await tmp();
    await writeImport(imported(), pack);
    const { manifest: existing } = await loadManifest(pack);

    // Swap atoms/ for a symlink to a directory holding an unrelated file: the
    // stale sweep sees it as an atom file the fresh import no longer emits.
    const elsewhere = await tmp();
    const victim = path.join(elsewhere, "keep-me.md");
    await fs.writeFile(victim, "untouched\n");
    await fs.rm(path.join(pack, "atoms"), { recursive: true, force: true });
    await fs.symlink(elsewhere, path.join(pack, "atoms"));

    await expect(
      foldImportInto({ result: imported(), existing, packDir: pack, apply: true }),
    ).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(victim, "utf8")).toBe("untouched\n");
    await fs.rm(pack, { recursive: true, force: true });
    await fs.rm(elsewhere, { recursive: true, force: true });
  });
});

describe("assertNoPathConflicts", () => {
  it("rejects a plan where one output is both a file and a directory", () => {
    expect(() => assertNoPathConflicts(["skills/a", "skills/a/SKILL.md"])).toThrow(
      /planned as a file/,
    );
  });

  it("accepts siblings that only share a name prefix", () => {
    expect(() =>
      assertNoPathConflicts(["skills/a/SKILL.md", "skills/ab/SKILL.md", "skills.md"]),
    ).not.toThrow();
  });
});
