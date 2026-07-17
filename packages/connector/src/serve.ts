#!/usr/bin/env node
import { serve } from "@hono/node-server";

import { loadPackCatalog } from "./catalog.js";
import { buildAllowedHosts, TOKEN_ENV_VAR, validateTokenEnv } from "./auth.js";
import { createApp } from "./server.js";

/**
 * Minimal launcher: `agentpack-connector <pack-path>`.
 *
 *   AGENTPACK_CONNECTOR_TOKEN (required) — bearer secret, ≥32 chars.
 *   AGENTPACK_CONNECTOR_PORT  (default 8787) — listen port.
 *   AGENTPACK_CONNECTOR_ALLOWED_HOSTS (optional, comma-separated) —
 *     additional hostnames for DNS-rebinding allowlist beyond the defaults
 *     (localhost, 127.0.0.1, [::1]).
 *
 * The server refuses to start if AGENTPACK_CONNECTOR_TOKEN is absent or
 * shorter than 32 characters (auth-by-default, fail-closed).
 */
async function main(): Promise<void> {
  // Fail fast before binding if the token is missing or too short.
  const token = validateTokenEnv();
  const allowedHosts = buildAllowedHosts();

  const source = process.argv[2] ?? process.cwd();
  const port = Number(process.env["AGENTPACK_CONNECTOR_PORT"] ?? 8787);

  const catalog = await loadPackCatalog(source);
  const app = createApp(catalog, token, allowedHosts);

  serve({ fetch: app.fetch, port }, (info) => {
    process.stdout.write(
      `agentpack connector for ${catalog.packId}@${catalog.packVersion}\n` +
        `  ${catalog.prompts.length} prompt(s), ${catalog.resources.length} resource(s)\n` +
        `  MCP endpoint:  http://localhost:${info.port}/mcp\n` +
        `  health:        http://localhost:${info.port}/healthz\n` +
        `  auth:          bearer token (${TOKEN_ENV_VAR})\n`,
    );
    if (catalog.excluded.length > 0) {
      process.stdout.write(
        `  not carried (terminal-only): ${catalog.excluded.map((e) => e.type).join(", ")}\n`,
      );
    }
  });
}

// Exported so tests can deterministically await startup (and the fail-closed
// path) instead of racing a fixed timeout. Running `node serve.js` still
// executes main() on import exactly as before; the export is inert in prod.
export const ready = main().catch((err: unknown) => {
  process.stderr.write(
    `agentpack-connector failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
