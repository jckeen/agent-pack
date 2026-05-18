import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Command } from "commander";
import pc from "picocolors";

type Check = {
  label: string;
  ok: boolean;
  detail?: string;
};

async function whichVersion(cmd: string): Promise<string | null> {
  try {
    const out = execSync(`${cmd} --version`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
      .split("\n")[0];
    return out ?? null;
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Run environment checks for the workgraph CLI.")
    .action(async () => {
      const cwd = process.cwd();
      const checks: Check[] = [];

      // Node
      const nodeVersion = process.version;
      const nodeOk = Number(process.versions.node.split(".")[0]) >= 18;
      checks.push({
        label: "node ≥ 18",
        ok: nodeOk,
        detail: nodeVersion,
      });

      // pnpm
      const pnpm = await whichVersion("pnpm");
      checks.push({
        label: "pnpm available",
        ok: !!pnpm,
        detail: pnpm ?? "(not found)",
      });

      // npm
      const npm = await whichVersion("npm");
      checks.push({
        label: "npm available",
        ok: !!npm,
        detail: npm ?? "(not found)",
      });

      // AGENTPACK.yaml in CWD or parent
      const manifest = path.join(cwd, "AGENTPACK.yaml");
      const manifestPresent = await pathExists(manifest);
      checks.push({
        label: "AGENTPACK.yaml in CWD",
        ok: manifestPresent,
        detail: manifestPresent
          ? manifest
          : "(none — run `workgraph init` to scaffold one)",
      });

      // Git
      const git = await whichVersion("git");
      checks.push({
        label: "git available",
        ok: !!git,
        detail: git ?? "(not found)",
      });

      for (const c of checks) {
        const glyph = c.ok ? pc.green("✓") : pc.yellow("!");
        console.log(`${glyph} ${c.label.padEnd(28)} ${pc.dim(c.detail ?? "")}`);
      }
      const failed = checks.filter((c) => !c.ok);
      if (failed.length === 0) {
        console.log(pc.green("\nAll checks passed."));
      } else {
        console.log(
          pc.yellow(
            `\n${failed.length} check(s) reported a warning — review above.`,
          ),
        );
      }
    });
}
