import type { Command } from "commander";
import pc from "picocolors";

import { DEFAULT_REGISTRY_URL } from "@workgraph/core";

import { getToken, maskToken } from "../lib/credentials.js";

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
}

export function registerTokens(program: Command): void {
  const tokens = program
    .command("tokens")
    .description("Manage CLI API tokens.");

  tokens
    .command("list")
    .description("List your tokens (prefix only — never the full token).")
    .option("--registry <url>", "registry URL", DEFAULT_REGISTRY_URL)
    .action(async (options: { registry: string }) => {
      const registry = options.registry.replace(/\/+$/, "");
      const bearer = await getToken(registry);
      if (!bearer) {
        console.log(pc.dim("Not logged in. Run `workgraph login`."));
        process.exit(0);
      }
      const res = await fetch(`${registry}/api/tokens`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      if (!res.ok) {
        console.error(pc.red(`/api/tokens → HTTP ${res.status}`));
        process.exit(1);
      }
      const body = (await res.json()) as { tokens: TokenRow[] };
      if (body.tokens.length === 0) {
        console.log(pc.dim("No tokens."));
        return;
      }
      for (const t of body.tokens) {
        console.log(
          `${pc.bold(t.name)} — ${pc.dim(t.prefix)} — scopes: ${t.scopes.join(
            ", "
          )} — used: ${t.last_used_at ?? "never"}`
        );
      }
    });

  tokens
    .command("create")
    .description("Mint a new token. The full token is shown ONCE.")
    .requiredOption("--name <n>", "token name")
    .option("--scopes <list>", "comma-separated scopes", "publish:packs")
    .option("--registry <url>", "registry URL", DEFAULT_REGISTRY_URL)
    .action(
      async (options: { name: string; scopes: string; registry: string }) => {
        const registry = options.registry.replace(/\/+$/, "");
        const bearer = await getToken(registry);
        if (!bearer) {
          console.error(pc.red("Not logged in. Run `workgraph login`."));
          process.exit(1);
        }
        const scopes = options.scopes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const res = await fetch(`${registry}/api/tokens`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: options.name, scopes }),
        });
        if (!res.ok) {
          console.error(pc.red(`token create → HTTP ${res.status}`));
          process.exit(1);
        }
        const body = (await res.json()) as {
          token: string;
          id: string;
          prefix: string;
        };
        console.log(pc.bold(pc.green("Token created. Save it now — it will not be shown again:")));
        console.log("");
        console.log(`  ${body.token}`);
        console.log("");
        console.log(pc.dim(`id: ${body.id}`));
        console.log(pc.dim(`display: ${maskToken(body.token)}`));
      }
    );

  tokens
    .command("revoke <tokenId>")
    .description("Revoke a token.")
    .option("--registry <url>", "registry URL", DEFAULT_REGISTRY_URL)
    .action(async (tokenId: string, options: { registry: string }) => {
      const registry = options.registry.replace(/\/+$/, "");
      const bearer = await getToken(registry);
      if (!bearer) {
        console.error(pc.red("Not logged in. Run `workgraph login`."));
        process.exit(1);
      }
      const res = await fetch(`${registry}/api/tokens/${tokenId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bearer}` },
      });
      if (!res.ok && res.status !== 204) {
        console.error(pc.red(`revoke → HTTP ${res.status}`));
        process.exit(1);
      }
      console.log(pc.green(`✓ Revoked ${tokenId}`));
    });
}
