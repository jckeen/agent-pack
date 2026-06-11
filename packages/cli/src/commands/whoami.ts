import type { Command } from "commander";
import pc from "picocolors";

import { DEFAULT_REGISTRY_URL } from "@agentpack/core";

import { getToken } from "../lib/credentials.js";

interface MeResponse {
  id: string;
  username: string;
  publisherSlugs: string[];
}

export function registerWhoami(program: Command): void {
  program
    .command("whoami")
    .description("Show the currently authenticated user.")
    .option("--registry <url>", "registry URL", DEFAULT_REGISTRY_URL)
    .action(async (options: { registry: string }) => {
      const registry = options.registry.replace(/\/+$/, "");
      const token = await getToken(registry);
      if (!token) {
        console.log(pc.dim("Not logged in. Run `agentpack login`."));
        process.exit(1);
      }
      try {
        const res = await fetch(`${registry}/api/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          console.error(pc.red("Token rejected. Re-run `agentpack login`."));
          process.exit(1);
        }
        if (!res.ok) {
          console.error(pc.red(`/api/me → HTTP ${res.status}`));
          process.exit(1);
        }
        const me = (await res.json()) as MeResponse;
        console.log(pc.bold(me.username));
        if (me.publisherSlugs.length > 0) {
          console.log(pc.dim(`publishers: ${me.publisherSlugs.join(", ")}`));
        } else {
          console.log(pc.dim("publishers: (none — create one on the registry)"));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`whoami failed: ${msg}`));
        process.exit(1);
      }
    });
}
