import * as fs from "node:fs/promises";
import * as path from "node:path";
import { zipSync, strToU8 } from "fflate";

import type { AgentPackManifest, McpAtom } from "../schema/types.js";
import { loadManifest } from "../parser/loadManifest.js";
import { validateManifest } from "../validator/validateManifest.js";
import { resolveAtoms, UnknownProfileError } from "../planner/resolveAtoms.js";
import { isShellEscape } from "../adapters/commandGate.js";

export interface ExportMcpbOptions {
  /** Path to the pack directory or AGENTPACK.yaml file. */
  source: string;
  profile?: string;
  /** Directory to write the `<slug>.mcpb` file into. */
  outDir: string;
  strict?: boolean;
  onlyAtoms?: string[];
}

export interface ExportMcpbResult {
  /** Absolute path to the emitted `.mcpb` file. */
  bundlePath: string;
  /**
   * Names of the stdio mcp_server atoms eligible for bundling. A `.mcpb`
   * manifest describes a single server; the first is bundled and any others
   * are reported in `skippedServers`.
   */
  serverNames: string[];
  /** Eligible servers beyond the first — split these into their own bundles. */
  skippedServers: string[];
  /** The manifest.json object embedded in the bundle (parsed). */
  manifest: McpbManifest;
  /**
   * Export-level warnings, e.g. bundled servers that declare target variants
   * (#133): `.mcpb` bundling reads only the atom's manifest fields and does
   * not run the planner's variant selection.
   */
  warnings: string[];
}

/** MCPB manifest schema (spec v0.3) — the subset AgentPack emits. */
export interface McpbManifest {
  manifest_version: "0.3";
  name: string;
  version: string;
  description: string;
  author: { name: string; email?: string; url?: string };
  homepage?: string;
  documentation?: string;
  license?: string;
  keywords?: string[];
  server: {
    type: "node" | "python" | "binary" | "uv";
    mcp_config: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
  user_config?: Record<string, McpbUserConfigField>;
}

interface McpbUserConfigField {
  type: "string" | "number" | "boolean" | "directory" | "file";
  title: string;
  description?: string;
  required: boolean;
  sensitive?: boolean;
}

/**
 * Compile an AgentPack's `mcp_server` atom(s) into an **`.mcpb` MCP Bundle** —
 * a ZIP with a root `manifest.json` (the MCP Bundle standard,
 * blog.modelcontextprotocol.io/posts/2025-11-20-adopting-mcpb) for one-click
 * **local** MCP install on Claude Cowork and Desktop. This is the portable
 * path for stdio servers there; the remote-connector config the adapters emit
 * only carries http/sse servers.
 *
 * The same gates as the `.mcp.json` emitter apply: a server must be declared in
 * `permissions.mcp.servers`, and shell-escape command shapes are refused —
 * otherwise the bundle would be a trivial arbitrary-execution vehicle. Required
 * secrets become `user_config` entries wired into `mcp_config.env` via
 * `${user_config.KEY}` substitution, so credentials are prompted at install
 * time and never baked into the bundle.
 */
export async function exportMcpb(options: ExportMcpbOptions): Promise<ExportMcpbResult> {
  const strict = options.strict ?? true;
  const loaded = await loadManifest(options.source);
  const validation = validateManifest(loaded.manifest);
  if (!validation.valid && strict) {
    const detail = validation.errors
      .map((e) => `[${e.code}] ${e.path}: ${e.message}`)
      .join("\n");
    throw new Error(`AgentPack manifest failed validation:\n${detail}`);
  }

  const profile = resolveProfile(loaded.manifest, options.profile);
  const resolved = resolveAtoms({
    manifest: loaded.manifest,
    profile,
    onlyAtoms: options.onlyAtoms,
  });

  const declaredServers = loaded.manifest.permissions?.mcp?.servers ?? [];
  const stdioServers: McpAtom[] = [];
  for (const r of resolved) {
    if (r.atom.type !== "mcp_server") continue;
    const a = r.atom as McpAtom;
    const slug = mcpSlug(a);
    if ((a.transport ?? "stdio") !== "stdio") continue; // remote → connector
    if (!declaredServers.includes(slug)) {
      throw new Error(
        `MCP server \`${a.id}\` is not declared in \`permissions.mcp.servers\`. Refusing to bundle it.`,
      );
    }
    if (!a.command || isShellEscape(a.command, a.args ?? [])) {
      throw new Error(
        `MCP server \`${a.id}\` command \`${[a.command ?? "", ...(a.args ?? [])].join(" ").trim() || "(empty)"}\` is empty or a shell-escape shape. Refusing to bundle it.`,
      );
    }
    stdioServers.push(a);
  }

  if (stdioServers.length === 0) {
    throw new Error(
      `Pack has no stdio mcp_server atoms in profile \`${profile}\` to bundle into a .mcpb. ` +
        `(.mcpb packages LOCAL stdio servers; http/sse servers ship as remote connectors.)`,
    );
  }

  // An MCPB manifest describes a single server. Bundle the first; report the
  // rest so the author can split them into separate bundles rather than have
  // them silently dropped.
  const primary = stdioServers[0]!;
  const manifest = buildManifest(loaded.manifest, primary);
  const slug = kebab(loaded.manifest.metadata.slug);
  const zipped = zipSync({
    "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
  });

  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const bundlePath = path.join(outDir, `${slug}.mcpb`);
  await fs.writeFile(bundlePath, zipped);

  return {
    bundlePath,
    serverNames: stdioServers.map((a) => mcpSlug(a)),
    skippedServers: stdioServers.slice(1).map((a) => mcpSlug(a)),
    manifest,
    warnings: stdioServers
      .filter((a) => Object.keys(a.variants ?? {}).length > 0)
      .map(
        (a) =>
          `Atom \`${a.id}\` declares target variants, which \`pack mcpb\` does not resolve — the bundle uses only the atom's manifest fields.`,
      ),
  };
}

function buildManifest(manifest: AgentPackManifest, server: McpAtom): McpbManifest {
  const m = manifest.metadata;
  const author = m.authors?.[0];
  const userConfig: Record<string, McpbUserConfigField> = {};
  const env: Record<string, string> = {};
  for (const [key, spec] of Object.entries(server.env ?? {})) {
    const required = typeof spec === "object" ? (spec.required ?? false) : false;
    const description = typeof spec === "object" ? spec.description : undefined;
    userConfig[key] = {
      type: "string",
      title: key,
      ...(description ? { description } : {}),
      required,
      sensitive: true,
    };
    env[key] = `\${user_config.${key}}`;
  }

  const out: McpbManifest = {
    manifest_version: "0.3",
    name: kebab(m.slug),
    version: m.version,
    description: m.description,
    author: {
      name: author?.name ?? m.publisher ?? kebab(m.slug),
      ...(author?.email ? { email: author.email } : {}),
      ...(author?.url ? { url: author.url } : {}),
    },
    server: {
      type: serverType(server.command ?? ""),
      mcp_config: {
        command: server.command ?? "",
        args: server.args ?? [],
        env,
      },
    },
  };
  if (m.homepage) out.homepage = m.homepage;
  if (m.license) out.license = m.license;
  if (m.tags && m.tags.length > 0) out.keywords = m.tags;
  if (Object.keys(userConfig).length > 0) out.user_config = userConfig;
  return out;
}

/** Map the launch command to an MCPB server runtime type. */
function serverType(command: string): McpbManifest["server"]["type"] {
  const base = path.basename(command).toLowerCase();
  if (base === "node" || base === "npx" || base === "bun" || base === "bunx") {
    return "node";
  }
  if (base === "python" || base === "python3" || base === "uv" || base === "uvx") {
    return base === "uv" || base === "uvx" ? "uv" : "python";
  }
  return "binary";
}

function mcpSlug(atom: McpAtom): string {
  const raw = atom.id.split(":")[1] ?? atom.name;
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function kebab(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "bundle"
  );
}

function resolveProfile(
  manifest: {
    profiles: Record<string, unknown>;
    exports?: { default_profile?: string };
  },
  requested?: string,
): string {
  if (requested) {
    if (!manifest.profiles[requested]) {
      throw new UnknownProfileError(requested, Object.keys(manifest.profiles));
    }
    return requested;
  }
  const declaredDefault = manifest.exports?.default_profile;
  if (declaredDefault && manifest.profiles[declaredDefault]) {
    return declaredDefault;
  }
  if (manifest.profiles.safe) return "safe";
  const declared = Object.keys(manifest.profiles).join(", ");
  throw new Error(
    `No profile specified and pack declares no \`exports.default_profile\` (or \`safe\`). Specify --profile <one of: ${declared}>.`,
  );
}
