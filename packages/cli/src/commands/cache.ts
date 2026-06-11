import type { Command } from "commander";
import pc from "picocolors";

import { cache } from "@agentpack/core";

import { confirm } from "../lib/prompt.js";

export function registerCache(program: Command): void {
  const cmd = program.command("cache").description("Manage the local content-addressed blob cache.");

  cmd
    .command("size")
    .description("Show total bytes + entry count of the cache.")
    .action(async () => {
      const s = await cache.cacheSize();
      console.log(`${humanBytes(s.totalBytes)} across ${s.entryCount} blobs`);
    });

  cmd
    .command("prune")
    .description("Remove blobs older than --max-age.")
    .option("--max-age <duration>", "max age (e.g. 30d, 12h, 45m)", "30d")
    .action(async (options: { maxAge: string }) => {
      const maxAgeMs = parseDuration(options.maxAge);
      if (maxAgeMs === null) {
        console.error(pc.red(`Invalid --max-age: ${options.maxAge}`));
        process.exit(1);
      }
      const result = await cache.cachePrune({ maxAgeMs });
      console.log(`${result.removed} blobs removed, ${humanBytes(result.freed)} freed`);
    });

  cmd
    .command("clear")
    .description("Empty the cache.")
    .option("-y, --yes", "skip confirmation", false)
    .action(async (options: { yes: boolean }) => {
      if (!options.yes) {
        const ok = await confirm("Clear the entire cache? [y/N] ");
        if (!ok) {
          console.log(pc.dim("Aborted."));
          process.exit(1);
        }
      }
      const result = await cache.cacheClear();
      console.log(`Cleared ${result.removed} blobs`);
    });
}

function parseDuration(input: string): number | null {
  const m = input.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!m || !m[1] || !m[2]) return null;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "s":
      return n * 1000;
    case "m":
      return n * 1000 * 60;
    case "h":
      return n * 1000 * 60 * 60;
    case "d":
      return n * 1000 * 60 * 60 * 24;
    default:
      return null;
  }
}

function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
