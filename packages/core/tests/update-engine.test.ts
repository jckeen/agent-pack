// Sync S2 (#111): the update engine — BASE/LOCAL/NEW three-way reconcile,
// surgical removals, exec-delta detection, and an install-grade apply with
// update_begin/update_commit WAL discipline (crash recovery included).
//
// BASE = what the pack wrote at install time (install manifest hashes +
// merge fragments). LOCAL = on-disk now. NEW = freshly planned output.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  planInstall,
  applyInstall,
  verifyInstall,
  resolveAgentpackPaths,
  readInstallManifest,
  readHistory,
  verifyChain,
  parseLockfileDocument,
} from "../src/install/index.js";
import {
  planUpdate,
  applyUpdate,
  computeExecDelta,
  UpdateConflictError,
} from "../src/install/update.js";
import { recoverIncomplete } from "../src/install/recovery.js";
import { historyEntrySchema } from "../src/install/history.js";

const GEN = { cli: "0.2.0-test", adapter: "0.2.0-test" };

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Write a minimal generic-target pack. Version/instruction/skill are variable. */
async function writePack(
  dir: string,
  opts: {
    version: string;
    instructionBody: string;
    includeSkill?: boolean;
    skillBody?: string;
  },
): Promise<void> {
  const includeSkill = opts.includeSkill ?? true;
  const atoms = [
    `  - id: "instruction:house"
    type: instruction
    name: "House Style"
    description: "A persistent instruction."
    path: "atoms/instructions/house.md"
    risk_level: low
    permissions: []`,
  ];
  if (includeSkill) {
    atoms.push(`  - id: "skill:notes"
    type: skill
    name: "Notes"
    description: "A note-taking skill."
    path: "atoms/skills/notes"
    skill_format: "agentskills"
    risk_level: low
    permissions: []`);
  }
  await fs.writeFile(
    path.join(dir, "AGENTPACK.yaml"),
    `agentpack: "1.0"
metadata:
  id: "fixture.update-pack"
  name: "Update Fixture Pack"
  slug: "update-fixture-pack"
  description: "Core fixture for the sync S2 update engine tests."
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
    generic:
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
${atoms.join("\n")}
exports:
  default_profile: full
  output_dir: "dist"
  lockfile: "AGENTPACK.lock"
adapters:
  generic:
    enabled: true
    output:
      instructions: "AGENTS.md"
      skills: "skills"
      manifest: "agentpack.json"
      readme: "README-agent.md"
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
  if (includeSkill) {
    await fs.mkdir(path.join(dir, "atoms/skills/notes"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "atoms/skills/notes/SKILL.md"),
      `---
name: notes
description: Use this skill to take notes.
---

${opts.skillBody ?? "# Notes v1\n"}`,
      "utf8",
    );
  }
}

/** Install v1 of the fixture pack into a fresh project; returns dirs. */
async function installV1(): Promise<{ project: string; packDir: string }> {
  const project = await tempDir("agentpack-upd-proj-");
  const packDir = await tempDir("agentpack-upd-pack-");
  await writePack(packDir, { version: "0.1.0", instructionBody: "# House v1\n" });
  const plan = await planInstall({
    source: packDir,
    target: "generic",
    projectRoot: project,
    generator: GEN,
  });
  await applyInstall({ plan, actor: { type: "cli", id: "test" } });
  return { project, packDir };
}

/** Plan an update from a v2 pack dir against the installed project. */
async function planV2(
  project: string,
  v2: Parameters<typeof writePack>[1],
): Promise<Awaited<ReturnType<typeof planUpdate>>> {
  const v2Dir = await tempDir("agentpack-upd-pack2-");
  await writePack(v2Dir, v2);
  const newPlan = await planInstall({
    source: v2Dir,
    target: "generic",
    projectRoot: project,
    generator: GEN,
  });
  const ws = await resolveAgentpackPaths(project);
  const prior = await readInstallManifest(ws, "fixture.update-pack");
  return planUpdate({ newPlan, priorManifest: prior });
}

async function dropLastHistoryEntry(projectRoot: string): Promise<void> {
  const ws = await resolveAgentpackPaths(projectRoot);
  const raw = await fs.readFile(ws.historyFile, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  lines.pop();
  await fs.writeFile(ws.historyFile, lines.join("\n") + "\n", "utf8");
}

describe("planUpdate — three-way reconcile", () => {
  it("LOCAL == BASE, NEW != BASE → clean update (marker file)", async () => {
    const { project } = await installV1();
    const up = await planV2(project, { version: "0.2.0", instructionBody: "# House v2\n" });
    expect(up.cleanUpdates).toContain("AGENTS.md");
    expect(up.conflicts).toHaveLength(0);
    expect(up.retainedDrift).toHaveLength(0);
  });

  it("LOCAL != BASE (edit inside our span), NEW != BASE → conflict", async () => {
    const { project } = await installV1();
    const agentsPath = path.join(project, "AGENTS.md");
    const current = await fs.readFile(agentsPath, "utf8");
    await fs.writeFile(agentsPath, current.replace("House v1", "House v1 EDITED"), "utf8");
    const up = await planV2(project, { version: "0.2.0", instructionBody: "# House v2\n" });
    expect(up.conflicts.map((c) => c.path)).toContain("AGENTS.md");
  });

  it("user content AROUND the marker span never conflicts", async () => {
    const { project } = await installV1();
    const agentsPath = path.join(project, "AGENTS.md");
    const current = await fs.readFile(agentsPath, "utf8");
    await fs.writeFile(
      agentsPath,
      `# My own header\n\n${current}\nMy trailing notes.\n`,
      "utf8",
    );
    const up = await planV2(project, { version: "0.2.0", instructionBody: "# House v2\n" });
    expect(up.cleanUpdates).toContain("AGENTS.md");
    expect(up.conflicts).toHaveLength(0);
  });

  it("LOCAL != BASE, NEW == BASE → retained drift, file left alone", async () => {
    const { project } = await installV1();
    const skillPath = path.join(project, "skills/notes/SKILL.md");
    await fs.appendFile(skillPath, "\nMy local improvement.\n");
    // v2 changes only the instruction — the skill is byte-identical upstream.
    const up = await planV2(project, { version: "0.2.0", instructionBody: "# House v2\n" });
    expect(up.retainedDrift).toContain("skills/notes/SKILL.md");
    expect(up.conflicts).toHaveLength(0);
    expect(up.cleanUpdates).not.toContain("skills/notes/SKILL.md");
  });

  it("markerless owned file (skill) updated upstream → clean update, not conflict", async () => {
    const { project } = await installV1();
    const up = await planV2(project, {
      version: "0.2.0",
      instructionBody: "# House v1\n",
      skillBody: "# Notes v2 — improved\n",
    });
    expect(up.cleanUpdates).toContain("skills/notes/SKILL.md");
    expect(up.conflicts).toHaveLength(0);
  });

  it("atom deleted upstream → its files planned for removal", async () => {
    const { project } = await installV1();
    const up = await planV2(project, {
      version: "0.2.0",
      instructionBody: "# House v2\n",
      includeSkill: false,
    });
    expect(up.removals.map((r) => r.path)).toContain("skills/notes/SKILL.md");
  });
});

describe("applyUpdate", () => {
  it("clean update applies, verify is clean, provenance + manifest updated", async () => {
    const { project } = await installV1();
    const up = await planV2(project, { version: "0.2.0", instructionBody: "# House v2\n" });
    await applyUpdate({ update: up, actor: { type: "cli", id: "test" } });

    const agents = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    expect(agents).toContain("House v2");

    const result = await verifyInstall({
      packId: "fixture.update-pack",
      projectRoot: project,
    });
    expect(result.clean, JSON.stringify(result.drift)).toBe(true);

    const ws = await resolveAgentpackPaths(project);
    const manifest = await readInstallManifest(ws, "fixture.update-pack");
    expect(manifest.packVersion).toBe("0.2.0");
    expect(manifest.previousPackVersion).toBe("0.1.0");
    expect(manifest.updatedAt).toBeTruthy();

    const lock = parseLockfileDocument(
      await fs.readFile(path.join(project, "AGENTPACK.lock"), "utf8"),
    );
    expect(lock.packs["fixture.update-pack"]?.packVersion).toBe("0.2.0");

    // WAL: update_begin + update_commit recorded, chain intact.
    const entries = await readHistory(ws);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("update_begin");
    expect(actions).toContain("update_commit");
    expect(verifyChain(entries).ok).toBe(true);
  });

  it("refuses unresolved conflicts, applies with theirs (local edit backed up)", async () => {
    const { project } = await installV1();
    const agentsPath = path.join(project, "AGENTS.md");
    const edited = (await fs.readFile(agentsPath, "utf8")).replace(
      "House v1",
      "House v1 EDITED",
    );
    await fs.writeFile(agentsPath, edited, "utf8");
    const up = await planV2(project, { version: "0.2.0", instructionBody: "# House v2\n" });
    await expect(applyUpdate({ update: up, actor: { type: "cli" } })).rejects.toThrow(
      UpdateConflictError,
    );
    // File untouched by the refusal.
    expect(await fs.readFile(agentsPath, "utf8")).toBe(edited);

    await applyUpdate({
      update: up,
      resolutions: { theirs: (p) => p === "AGENTS.md" },
      actor: { type: "cli" },
    });
    const after = await fs.readFile(agentsPath, "utf8");
    expect(after).toContain("House v2");
    expect(after).not.toContain("EDITED");
    // The overwritten local edit is restorable from a backup.
    const ws = await resolveAgentpackPaths(project);
    const manifest = await readInstallManifest(ws, "fixture.update-pack");
    const backup = manifest.backups.find((b) => b.original === "AGENTS.md");
    expect(backup).toBeTruthy();
    const backedUp = await fs.readFile(path.join(project, backup!.backupPath), "utf8");
    expect(backedUp).toContain("EDITED");
  });

  it("keepLocal retains the local edit and skips the write", async () => {
    const { project } = await installV1();
    const agentsPath = path.join(project, "AGENTS.md");
    const edited = (await fs.readFile(agentsPath, "utf8")).replace(
      "House v1",
      "House v1 EDITED",
    );
    await fs.writeFile(agentsPath, edited, "utf8");
    const up = await planV2(project, { version: "0.2.0", instructionBody: "# House v2\n" });
    await applyUpdate({
      update: up,
      resolutions: { keepLocal: (p) => p === "AGENTS.md" },
      actor: { type: "cli" },
    });
    expect(await fs.readFile(agentsPath, "utf8")).toBe(edited);
  });

  it("upstream-deleted atom's files are removed; user files untouched", async () => {
    const { project } = await installV1();
    const userFile = path.join(project, "skills/notes/my-notes.md");
    await fs.writeFile(userFile, "mine\n", "utf8");
    const up = await planV2(project, {
      version: "0.2.0",
      instructionBody: "# House v2\n",
      includeSkill: false,
    });
    const result = await applyUpdate({ update: up, actor: { type: "cli" } });
    expect(result.removed).toContain("skills/notes/SKILL.md");
    await expect(fs.access(path.join(project, "skills/notes/SKILL.md"))).rejects.toThrow();
    expect(await fs.readFile(userFile, "utf8")).toBe("mine\n");
  });

  it("a user-edited removal target is skipped and reported, not deleted", async () => {
    const { project } = await installV1();
    const skillPath = path.join(project, "skills/notes/SKILL.md");
    await fs.appendFile(skillPath, "\nMy local improvement.\n");
    const up = await planV2(project, {
      version: "0.2.0",
      instructionBody: "# House v2\n",
      includeSkill: false,
    });
    const result = await applyUpdate({ update: up, actor: { type: "cli" } });
    expect(result.skippedRemovals).toContain("skills/notes/SKILL.md");
    await expect(fs.access(skillPath)).resolves.toBeUndefined();
  });

  it("crash between update_begin and update_commit is rolled back by the recovery sweep", async () => {
    const { project } = await installV1();
    const before = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    const up = await planV2(project, { version: "0.2.0", instructionBody: "# House v2\n" });
    // Snapshot the pre-update manifest — the crash state below is "file
    // writes done, manifest + commit row never written".
    const ws = await resolveAgentpackPaths(project);
    const manifestPath = path.join(ws.installedDir, "fixture.update-pack.json");
    const priorManifestRaw = await fs.readFile(manifestPath, "utf8");
    await applyUpdate({ update: up, actor: { type: "cli" } });
    // Simulate the crash: drop the update_commit row and restore the PRIOR
    // manifest. Roll-forward must refuse (stale manifest version) and the
    // sweep must roll the written files back to their pre-update content.
    await dropLastHistoryEntry(project);
    await fs.writeFile(manifestPath, priorManifestRaw, "utf8");
    const rec = await recoverIncomplete(project);
    expect(rec.rolledBack.length).toBeGreaterThan(0);
    const restored = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    expect(restored).toBe(before);

    // The complementary WAL property: a FULLY-written update missing only its
    // commit row is rolled FORWARD (commit synthesized), not undone.
    const up2 = await planV2(project, {
      version: "0.3.0",
      instructionBody: "# House v3\n",
    });
    await applyUpdate({ update: up2, actor: { type: "cli" } });
    await dropLastHistoryEntry(project);
    const rec2 = await recoverIncomplete(project);
    expect(rec2.recovered.length).toBeGreaterThan(0);
    const kept = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    expect(kept).toContain("House v3");
  });
});

describe("computeExecDelta", () => {
  const manifestStub = {
    atomIds: ["instruction:house", "hook:existing"],
  } as unknown as Parameters<typeof computeExecDelta>[0]["priorManifest"];

  it("flags an exec atom id absent from the prior manifest as added", () => {
    const delta = computeExecDelta({
      priorManifest: manifestStub,
      atomTypes: [
        { id: "instruction:house", type: "instruction" },
        { id: "hook:existing", type: "hook" },
        { id: "hook:new-hook", type: "hook" },
      ],
      writtenPaths: [],
      removedPaths: [],
      writtenContents: new Map(),
    });
    expect(delta.addedExecAtoms).toEqual(["hook:new-hook"]);
  });

  it("flags written exec-surface files (hooks dir, mcp config, settings.json with hook atoms)", () => {
    const delta = computeExecDelta({
      priorManifest: manifestStub,
      atomTypes: [{ id: "hook:existing", type: "hook" }],
      writtenPaths: [".claude/hooks/check.sh", ".claude/settings.json", "AGENTS.md"],
      removedPaths: [".mcp.json"],
      writtenContents: new Map(),
    });
    expect(delta.execSurfaceWrites).toContain(".claude/hooks/check.sh");
    expect(delta.execSurfaceWrites).toContain(".claude/settings.json");
    expect(delta.execSurfaceWrites).toContain(".mcp.json");
    expect(delta.execSurfaceWrites).not.toContain("AGENTS.md");
  });

  it("flags a written command/agent body containing a bang-bash directive", () => {
    const delta = computeExecDelta({
      priorManifest: manifestStub,
      atomTypes: [],
      writtenPaths: [".claude/commands/deploy.md"],
      removedPaths: [],
      writtenContents: new Map([
        [".claude/commands/deploy.md", "Run !`rm -rf` on invocation"],
      ]),
    });
    expect(delta.execSurfaceWrites).toContain(".claude/commands/deploy.md");
  });

  it("is empty for a pure-instruction delta", () => {
    const delta = computeExecDelta({
      priorManifest: manifestStub,
      atomTypes: [{ id: "instruction:house", type: "instruction" }],
      writtenPaths: ["AGENTS.md", "skills/notes/SKILL.md"],
      removedPaths: [],
      writtenContents: new Map(),
    });
    expect(delta.addedExecAtoms).toHaveLength(0);
    expect(delta.execSurfaceWrites).toHaveLength(0);
  });
});

describe("history schema", () => {
  it("accepts update_begin / update_commit actions", () => {
    for (const action of ["update_begin", "update_commit"]) {
      const parsed = historyEntrySchema.safeParse({
        id: "01TEST",
        action,
        timestamp: "2026-07-10T00:00:00.000Z",
        packId: "fixture.update-pack",
        packVersion: "0.2.0",
        target: "generic",
        profile: "full",
        actor: { type: "cli" },
        result: "success",
        previousEntryId: "",
        entryChecksum: "a".repeat(64),
      });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });
});

describe("S2 security hardening (review round)", () => {
  it("manifest schema rejects a backupPath with traversal or outside .agentpack/backups/", async () => {
    const { parseInstallManifest } = await import("../src/install/manifest.js");
    const base = {
      manifestVersion: 1,
      packId: "x.y",
      packVersion: "0.1.0",
      target: "generic",
      profile: "full",
      installedAt: "2026-07-10T00:00:00.000Z",
      cliVersion: "0.0.0",
      adapterVersions: {},
      created: [],
      modified: [{ path: "docs/notes.md", sha256: "a".repeat(64) }],
      backups: [] as unknown[],
      atomIds: [],
      lockfileChecksum: "0".repeat(64),
      rollbackable: true,
    };
    const withBackup = (backupPath: string) =>
      JSON.stringify({
        ...base,
        backups: [
          { original: "docs/notes.md", backupPath, originalSha256: "b".repeat(64) },
        ],
      });
    expect(() =>
      parseInstallManifest(withBackup("../../../../home/victim/.ssh/id_rsa")),
    ).toThrow();
    expect(() => parseInstallManifest(withBackup("secrets/elsewhere.txt"))).toThrow();
    expect(() =>
      parseInstallManifest(withBackup(".agentpack/backups/x.y/123.abc/docs/notes.md")),
    ).not.toThrow();
  });

  it("recovery sweep refuses to act on a history whose hash chain is broken", async () => {
    const { project } = await installV1();
    const skillPath = path.join(project, "skills/notes/SKILL.md");
    const skillBefore = await fs.readFile(skillPath, "utf8");
    // Tamper an existing entry (breaking the chain) — a forged/committed
    // history must not be able to drive the sweep's unlink machinery.
    const ws = await resolveAgentpackPaths(project);
    const raw = await fs.readFile(ws.historyFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const first = JSON.parse(lines[0]!) as { packVersion: string };
    first.packVersion = "6.6.6"; // checksum no longer matches
    lines[0] = JSON.stringify(first);
    await fs.writeFile(ws.historyFile, lines.join("\n") + "\n", "utf8");

    await expect(recoverIncomplete(project)).rejects.toThrow(/chain/i);
    expect(await fs.readFile(skillPath, "utf8")).toBe(skillBefore);
  });
});

describe("computeExecDelta — codex surfaces", () => {
  it("flags .codex/config.toml (MCP command lines) as an exec surface", () => {
    const delta = computeExecDelta({
      priorManifest: { atomIds: ["mcp_server:x"] } as never,
      atomTypes: [{ id: "mcp_server:x", type: "mcp_server" }],
      writtenPaths: [".codex/config.toml"],
      removedPaths: [],
      writtenContents: new Map(),
    });
    expect(delta.execSurfaceWrites).toContain(".codex/config.toml");
  });
});

describe("S2 removal crash-safety (review round)", () => {
  // A marker removal whose file still holds user content around our span is
  // a WRITE-kind removal (remainder rewritten in place). The instructions
  // file is always emitted by the adapters, so a real atom-drop can't produce
  // this; construct the UpdatePlan directly to exercise the exact WAL path the
  // review flagged — previously it could not roll back (removal targets lived
  // only in requiredBackups, and the restore used create-only writes that
  // EEXIST on a still-present file → silent corruption reported as clean).
  async function setupWriteKindRemoval(): Promise<{
    project: string;
    agentsBefore: string;
    up: Awaited<ReturnType<typeof planUpdate>>;
    ws: Awaited<ReturnType<typeof resolveAgentpackPaths>>;
    manifestPath: string;
    priorManifestRaw: string;
  }> {
    const { project, packDir } = await installV1();
    const agentsPath = path.join(project, "AGENTS.md");
    const agentsBefore = `# My own header\n\n${await fs.readFile(agentsPath, "utf8")}\nMy trailing notes.\n`;
    await fs.writeFile(agentsPath, agentsBefore, "utf8");
    const ws = await resolveAgentpackPaths(project);
    const manifestPath = path.join(ws.installedDir, "fixture.update-pack.json");
    const priorManifestRaw = await fs.readFile(manifestPath, "utf8");
    const prior = await readInstallManifest(ws, "fixture.update-pack");
    // A no-op re-plan of the same pack, then override to make AGENTS.md a
    // marker removal with nothing else written.
    const newPlan = await planInstall({
      source: packDir,
      target: "generic",
      projectRoot: project,
      generator: GEN,
    });
    const base = await planUpdate({ newPlan, priorManifest: prior });
    const up = {
      ...base,
      cleanUpdates: [],
      writeFiles: [],
      retainedDrift: [],
      conflicts: [],
      removals: [{ path: "AGENTS.md", strategy: "marker" as const }],
    };
    return { project, agentsBefore, up, ws, manifestPath, priorManifestRaw };
  }

  it("a crash after a write-kind removal is rolled back (file restored, not silently corrupted)", async () => {
    const { project, agentsBefore, up, ws, manifestPath, priorManifestRaw } =
      await setupWriteKindRemoval();
    await applyUpdate({ update: up, actor: { type: "cli" } });
    // Crash state: files + removals done, manifest + commit row not written.
    const raw = await fs.readFile(ws.historyFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    lines.pop();
    await fs.writeFile(ws.historyFile, lines.join("\n") + "\n", "utf8");
    await fs.writeFile(manifestPath, priorManifestRaw, "utf8");

    const rec = await recoverIncomplete(project);
    expect(rec.rolledBack.length, JSON.stringify(rec)).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(project, "AGENTS.md"), "utf8")).toBe(agentsBefore);
  });

  it("a synchronous apply failure after removals restores the removal targets", async () => {
    const { project, agentsBefore, up } = await setupWriteKindRemoval();
    // Sabotage the lockfile write (runs AFTER removals).
    await fs.rm(path.join(project, "AGENTPACK.lock"));
    await fs.mkdir(path.join(project, "AGENTPACK.lock", "block"), { recursive: true });
    await expect(applyUpdate({ update: up, actor: { type: "cli" } })).rejects.toThrow();
    expect(await fs.readFile(path.join(project, "AGENTS.md"), "utf8")).toBe(agentsBefore);
  });

  it("a FAILED commit record does not stop the recovery sweep from revisiting the begin entry", async () => {
    const { project } = await installV1();
    const before = await fs.readFile(path.join(project, "AGENTS.md"), "utf8");
    const up = await planV2(project, { version: "0.2.0", instructionBody: "# House v2\n" });
    const ws = await resolveAgentpackPaths(project);
    const manifestPath = path.join(ws.installedDir, "fixture.update-pack.json");
    const priorManifestRaw = await fs.readFile(manifestPath, "utf8");
    await applyUpdate({ update: up, actor: { type: "cli" } });
    // Crash state as before…
    const raw = await fs.readFile(ws.historyFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const commit = JSON.parse(lines[lines.length - 1]!) as { recoveredBegin?: string };
    const beginId = (JSON.parse(lines[lines.length - 2]!) as { id: string }).id;
    void commit;
    lines.pop();
    await fs.writeFile(ws.historyFile, lines.join("\n") + "\n", "utf8");
    await fs.writeFile(manifestPath, priorManifestRaw, "utf8");
    // …plus the failed-commit row the apply catch-path writes: it references
    // the begin via recoveredBegin with result "failed". That reference must
    // NOT mark the begin as resolved.
    const { recordHistory, newHistoryId } = await import("../src/install/history.js");
    await recordHistory(ws, {
      id: newHistoryId(),
      action: "update_commit",
      timestamp: new Date().toISOString(),
      packId: "fixture.update-pack",
      packVersion: "0.2.0",
      target: "generic",
      profile: "full",
      actor: { type: "cli" },
      result: "failed",
      error: "simulated apply failure",
      recoveredBegin: beginId,
    });
    const rec = await recoverIncomplete(project);
    expect(rec.rolledBack.length, JSON.stringify(rec)).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(project, "AGENTS.md"), "utf8")).toBe(before);
  });
});
