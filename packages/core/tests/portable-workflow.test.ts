import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { expect, it } from "vitest";
import { exportChat } from "../src/exports/exportChat.js";

it("the portable starter carries complete native skills into Claude upload ZIPs", async () => {
  const source = path.resolve(__dirname, "../../../examples/portable-workflow");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "portable-workflow-"));
  try {
    const result = await exportChat({ source, outDir, profile: "safe" });
    expect(result.warnings).toEqual([]);
    const native = result.skills.filter((skill) => skill.kind === "native");
    expect(native.map((skill) => skill.skillName).sort()).toEqual([
      "decision-memo",
      "research-brief",
    ]);
    for (const skill of native) {
      const zip = unzipSync(await fs.readFile(skill.zipPath));
      const original = await fs.readFile(
        path.join(source, "atoms", skill.skillName, "SKILL.md"),
        "utf8",
      );
      expect(strFromU8(zip[`${skill.skillName}/SKILL.md`]!)).toBe(original);
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
