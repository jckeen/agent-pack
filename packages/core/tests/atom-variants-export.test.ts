// Issue #133 review: `pack chat` / `pack mcpb` bypass the planner's
// selectAtomVariants (they call resolveAtoms directly), so variants are NOT
// resolved there. That limitation must be loud and honest:
//  - a variant-only atom (no default `path`/`body`) compiles to a
//    description-only fallback WITH an explicit warning naming the true
//    reason — never the misleading "directory `undefined` has no SKILL.md";
//  - a variant-only mcp_server atom is skipped from connectors.json with a
//    warning instead of silently vanishing;
//  - `.mcpb` bundling warns when a bundled server declares variants.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { exportChat } from "../src/exports/exportChat.js";
import { exportMcpb } from "../src/exports/exportMcpb.js";
import type { AgentPackManifest } from "../src/index.js";

async function makeVariantsPack(): Promise<string> {
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpack-variants-export-"));
  const manifest: AgentPackManifest = {
    agentpack: "1.0",
    metadata: {
      id: "agentpack.variants-export",
      name: "Variants Export",
      slug: "variants-export",
      description: "Pack with variant-only atoms for chat/mcpb export tests.",
      version: "0.1.0",
      publisher: "agentpack",
    },
    compatibility: { targets: { "claude-code": { status: "supported" } } },
    permissions: { mcp: { servers: ["searcher", "local-tools"] } },
    profiles: { all: { include: ["*"] } },
    atoms: [
      {
        id: "skill:review",
        type: "skill",
        name: "Review",
        description: "A review skill that only ships target variants.",
        risk_level: "low",
        variants: { "claude-code": { path: "atoms/skills/review-claude" } },
      },
      {
        id: "instruction:house-style",
        type: "instruction",
        name: "House Style",
        description: "Instruction that only ships target variants.",
        risk_level: "low",
        variants: { "claude-code": { body: "Claude-only house style." } },
      },
      {
        id: "mcp_server:searcher",
        type: "mcp_server",
        name: "Searcher",
        description: "Remote MCP server whose descriptor is variant-only.",
        risk_level: "medium",
        transport: "http",
        url: "https://mcp.example.com/searcher",
        variants: { "claude-code": { path: "atoms/mcp/searcher.claude.yaml" } },
      },
      {
        id: "mcp_server:local-tools",
        type: "mcp_server",
        name: "Local Tools",
        description: "Stdio MCP server that declares variants.",
        risk_level: "medium",
        transport: "stdio",
        command: "local-tools",
        path: "atoms/mcp/local-tools.yaml",
        variants: { "claude-code": { path: "atoms/mcp/local-tools.claude.yaml" } },
      },
    ],
  };
  await fs.mkdir(path.join(packDir, "atoms/mcp"), { recursive: true });
  await fs.writeFile(
    path.join(packDir, "AGENTPACK.yaml"),
    stringifyYaml(manifest, { lineWidth: 0 }),
  );
  await fs.writeFile(
    path.join(packDir, "atoms/mcp/local-tools.yaml"),
    stringifyYaml({ transport: "stdio", command: "local-tools" }),
  );
  await fs.writeFile(
    path.join(packDir, "atoms/mcp/local-tools.claude.yaml"),
    stringifyYaml({ transport: "stdio", command: "local-tools" }),
  );
  return packDir;
}

describe("pack chat with variant-only atoms (#133 review)", () => {
  it("warns with the true reason and never prints `undefined`", async () => {
    const packDir = await makeVariantsPack();
    const outDir = path.join(packDir, "dist-chat");
    try {
      const result = await exportChat({ source: packDir, profile: "all", outDir, strict: true });

      const allWarnings = [...result.warnings, ...result.skills.flatMap((s) => s.warnings)];
      // Native skill: description fallback with an explicit variants warning.
      expect(
        allWarnings.some(
          (w) => w.includes("skill:review") && w.includes("target variants"),
        ),
      ).toBe(true);
      // On-invoke bridge (instruction): same explicit reason.
      expect(
        allWarnings.some(
          (w) => w.includes("instruction:house-style") && w.includes("target variants"),
        ),
      ).toBe(true);
      // Connector flow: variant-only descriptor is skipped LOUDLY.
      expect(
        result.warnings.some(
          (w) => w.includes("mcp_server:searcher") && w.includes("target variants"),
        ),
      ).toBe(true);
      expect(result.connectors.map((c) => c.atom)).not.toContain("mcp_server:searcher");

      // No `undefined` interpolation anywhere — warnings or written text files.
      for (const w of allWarnings) expect(w).not.toContain("undefined");
      for (const rel of result.writtenFiles) {
        if (rel.endsWith(".zip") || rel.endsWith(".mcpb")) continue;
        const content = await fs.readFile(path.join(outDir, rel), "utf8");
        expect(content, rel).not.toContain("`undefined`");
      }
    } finally {
      await fs.rm(packDir, { recursive: true, force: true });
    }
  });
});

describe("pack mcpb with variant-declaring servers (#133 review)", () => {
  it("warns that variants are not resolved by .mcpb bundling", async () => {
    const packDir = await makeVariantsPack();
    const outDir = path.join(packDir, "dist-mcpb");
    try {
      const result = await exportMcpb({ source: packDir, profile: "all", outDir, strict: true });
      expect(
        result.warnings.some(
          (w) => w.includes("mcp_server:local-tools") && w.includes("target variants"),
        ),
      ).toBe(true);
    } finally {
      await fs.rm(packDir, { recursive: true, force: true });
    }
  });
});
