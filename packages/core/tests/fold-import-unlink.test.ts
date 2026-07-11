// Antigravity review round on PR #121: an ENOENT from the stale-atom unlink
// means the desired end-state (file gone) already holds — e.g. the file
// disappeared between the stale walk and the unlink — so it must NOT be
// collected as a removalFailure. Every other unlink error still is one
// (guarding the #122 behavior).
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Delegate everything to the real fs except unlink on paths registered in
// `unlinkErrors` (suffix → errno code).
const unlinkErrors = new Map<string, string>();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (p: Parameters<typeof actual.unlink>[0]) => {
      for (const [suffix, code] of unlinkErrors) {
        if (String(p).endsWith(suffix)) {
          const err = new Error(`${code}: mocked unlink failure`) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        }
      }
      return actual.unlink(p);
    },
  };
});

import * as fs from "node:fs/promises";
import { foldImportInto, type ImportResult } from "../src/importer/index.js";
import type { AgentPackManifest } from "../src/schema/types.js";

const TMP_ROOT = nodePath.join(os.tmpdir(), `agentpack-fold-unlink-${Date.now()}`);

afterAll(async () => {
  unlinkErrors.clear();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  unlinkErrors.clear();
});

function minimalManifest(): AgentPackManifest {
  return {
    agentpack: "1.0",
    metadata: {
      id: "me.fold",
      name: "Fold",
      slug: "fold",
      description: "test",
      version: "0.1.0",
      license: "MIT",
      publisher: "me",
    },
    compatibility: { targets: {} },
    profiles: { all: { description: "all", include: ["*"] } },
    atoms: [],
  } as unknown as AgentPackManifest;
}

/** Pack dir with one kept atom file and one STALE file the fold removes. */
async function seedPack(name: string): Promise<{ packDir: string; result: ImportResult }> {
  const packDir = nodePath.join(TMP_ROOT, name);
  await fs.mkdir(nodePath.join(packDir, "atoms/instructions"), { recursive: true });
  await fs.mkdir(nodePath.join(packDir, "atoms/skills/old"), { recursive: true });
  await fs.writeFile(nodePath.join(packDir, "AGENTPACK.yaml"), "placeholder\n");
  await fs.writeFile(nodePath.join(packDir, "atoms/instructions/notes.md"), "hello\n");
  await fs.writeFile(nodePath.join(packDir, "atoms/skills/old/SKILL.md"), "stale\n");
  const result: ImportResult = {
    manifest: minimalManifest(),
    files: [
      { relativePath: "AGENTPACK.yaml", content: "placeholder\n" },
      { relativePath: "atoms/instructions/notes.md", content: "hello\n" },
    ],
    warnings: [],
  };
  return { packDir, result };
}

describe("foldImportInto stale-removal error handling", () => {
  it("tolerates ENOENT (file already gone = desired end-state)", async () => {
    const { packDir, result } = await seedPack("enoent");
    unlinkErrors.set("atoms/skills/old/SKILL.md", "ENOENT");
    const fold = await foldImportInto({
      result,
      existing: minimalManifest(),
      packDir,
      apply: true,
    });
    expect(fold.changes.some((c) => c.kind === "removed")).toBe(true);
    expect(fold.removalFailures).toEqual([]);
  });

  it("still reports every non-ENOENT unlink failure (#122)", async () => {
    const { packDir, result } = await seedPack("eacces");
    unlinkErrors.set("atoms/skills/old/SKILL.md", "EACCES");
    const fold = await foldImportInto({
      result,
      existing: minimalManifest(),
      packDir,
      apply: true,
    });
    expect(fold.removalFailures).toHaveLength(1);
    expect(fold.removalFailures[0]!.path).toBe("atoms/skills/old/SKILL.md");
    expect(fold.removalFailures[0]!.error).toMatch(/EACCES/);
  });
});
