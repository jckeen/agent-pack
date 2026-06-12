#!/usr/bin/env node
import { serve } from "@hono/node-server";

import { loadPackCatalog } from "./catalog.js";
import { createApp } from "./server.js";

/**
 * Minimal launcher: `agentpack-connector <pack-path>`.
 *
 *   AGENTPACK_CONNECTOR_PORT (default 8787) — listen port.
 *
 * Prototype only — binds with no auth. Add bearer auth + DNS-rebinding
 * protection before exposing publicly (see README).
 */
async function main(): Promise<void> {
  const source = process.argv[2] ?? process.cwd();
  const port = Number(process.env["AGENTPACK_CONNECTOR_PORT"] ?? 8787);

  const catalog = await loadPackCatalog(source);
  const app = createApp(catalog);

  serve({ fetch: app.fetch, port }, (info) => {
    process.stdout.write(
      `agentpack connector for ${catalog.packId}@${catalog.packVersion}\n` +
        `  ${catalog.prompts.length} prompt(s), ${catalog.resources.length} resource(s)\n` +
        `  MCP endpoint:  http://localhost:${info.port}/mcp\n` +
        `  health:        http://localhost:${info.port}/healthz\n`,
    );
    if (catalog.excluded.length > 0) {
      process.stdout.write(
        `  not carried (terminal-only): ${catalog.excluded.map((e) => e.type).join(", ")}\n`,
      );
    }
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `agentpack-connector failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
