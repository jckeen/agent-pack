import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync, strFromU8 } from "fflate";

import { exportMcpb } from "../src/exports/exportMcpb.js";

const EXAMPLE = path.resolve(__dirname, "../../../examples/pr-quality");

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-mcpb-"));
}

/** Read the emitted .mcpb back into a {path -> bytes} map. */
async function readBundle(file: string): Promise<Record<string, Uint8Array>> {
  const bytes = await fs.readFile(file);
  return unzipSync(new Uint8Array(bytes));
}

describe("exportMcpb", () => {
  it("packages the pack's stdio mcp_server atoms into a valid .mcpb", async () => {
    const out = await tmp();
    const result = await exportMcpb({
      source: EXAMPLE,
      profile: "full",
      outDir: out,
    });

    // The bundle file exists where the result says it does, named *.mcpb.
    expect(result.bundlePath.endsWith(".mcpb")).toBe(true);
    await expect(fs.stat(result.bundlePath)).resolves.toBeTruthy();
    expect(result.serverNames).toContain("github");

    // The bundle is a real ZIP with manifest.json at its root.
    const entries = await readBundle(result.bundlePath);
    expect(entries["manifest.json"]).toBeTruthy();

    const manifest = JSON.parse(strFromU8(entries["manifest.json"]));

    // Required MCPB manifest fields, manifest_version pinned to the live spec.
    expect(manifest.manifest_version).toBe("0.3");
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.version).toBe("0.1.0");
    expect(typeof manifest.description).toBe("string");
    expect(manifest.author?.name).toBe("AgentPack");

    // server block: a node/binary stdio server with mcp_config.
    expect(manifest.server?.type).toBeTruthy();
    expect(manifest.server.mcp_config?.command).toBe("npx");
    expect(manifest.server.mcp_config.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-github",
    ]);

    // Required secrets surface as user_config and are wired into env via
    // ${user_config.KEY} substitution — never hardcoded.
    expect(manifest.user_config?.GITHUB_TOKEN).toBeTruthy();
    expect(manifest.user_config.GITHUB_TOKEN.required).toBe(true);
    expect(manifest.user_config.GITHUB_TOKEN.sensitive).toBe(true);
    expect(manifest.server.mcp_config.env.GITHUB_TOKEN).toBe("${user_config.GITHUB_TOKEN}");

    await fs.rm(out, { recursive: true, force: true });
  });

  it("round-trips: the emitted manifest re-parses with all servers it claims", async () => {
    const out = await tmp();
    const result = await exportMcpb({
      source: EXAMPLE,
      profile: "full",
      outDir: out,
    });
    const entries = await readBundle(result.bundlePath);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
    // Single-server packs collapse to server.mcp_config; the name is recorded.
    expect(result.serverNames.length).toBeGreaterThan(0);
    expect(manifest.server.mcp_config.command).toBeTruthy();
    await fs.rm(out, { recursive: true, force: true });
  });

  it("refuses to emit when the pack has no stdio mcp_server atoms", async () => {
    const out = await tmp();
    // The `safe` profile excludes the (high-risk) MCP server.
    await expect(
      exportMcpb({ source: EXAMPLE, profile: "safe", outDir: out }),
    ).rejects.toThrow(/no .*mcp_server/i);
    await fs.rm(out, { recursive: true, force: true });
  });
});
