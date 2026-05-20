import { spawn } from "node:child_process";
import type { Command } from "commander";

import { DEFAULT_REGISTRY_URL } from "@agentpack/core";
import pc from "picocolors";

import { writeCredentials, maskToken } from "../lib/credentials.js";

interface InitResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
}

type PollResponse =
  | { status: "pending" }
  | {
      status: "complete";
      token: string;
      user: { id: string; username: string; publisherSlugs: string[] };
    }
  | { status: "expired" };

export function registerLogin(program: Command): void {
  program
    .command("login")
    .description("Authenticate the CLI against the AgentPack Registry.")
    .option("--registry <url>", "registry URL", DEFAULT_REGISTRY_URL)
    .action(async (options: { registry: string }) => {
      try {
        const registry = options.registry.replace(/\/+$/, "");
        const initRes = await fetch(`${registry}/api/cli/auth/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientName: "agentpack-cli" }),
        });
        if (!initRes.ok) {
          console.error(
            pc.red(
              `Auth init failed: ${initRes.status} ${initRes.statusText}. Is the registry up?`
            )
          );
          process.exit(1);
        }
        const init = (await initRes.json()) as InitResponse;
        console.log(pc.bold(`\nAgentPack CLI login`));
        console.log(`Visit: ${pc.cyan(init.verificationUrl)}`);
        console.log(`Enter code: ${pc.yellow(pc.bold(init.userCode))}`);
        console.log(pc.dim(`(expires ${init.expiresAt})`));
        tryOpen(init.verificationUrl);

        const deadline = new Date(init.expiresAt).getTime();
        const interval = Math.max((init.interval || 5) * 1000, 1000);
        while (Date.now() < deadline) {
          await sleep(interval);
          const pollRes = await fetch(`${registry}/api/cli/auth/poll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceCode: init.deviceCode }),
          });
          if (!pollRes.ok) continue;
          const poll = (await pollRes.json()) as PollResponse;
          if (poll.status === "pending") {
            process.stdout.write(".");
            continue;
          }
          if (poll.status === "expired") {
            console.error(pc.red("\nLogin expired. Re-run `agentpack login`."));
            process.exit(1);
          }
          if (poll.status === "complete") {
            await writeCredentials(registry, {
              token: poll.token,
              scopes: ["read:packs", "publish:packs"],
              username: poll.user.username,
            });
            console.log(
              pc.green(
                `\n✓ Logged in as ${poll.user.username} (${maskToken(
                  poll.token
                )})`
              )
            );
            if (poll.user.publisherSlugs.length > 0) {
              console.log(
                pc.dim(`  publishers: ${poll.user.publisherSlugs.join(", ")}`)
              );
            }
            return;
          }
        }
        console.error(pc.red("\nLogin timed out. Re-run `agentpack login`."));
        process.exit(1);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`login failed: ${msg}`));
        process.exit(1);
      }
    });
}

function tryOpen(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* user can copy/paste */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
