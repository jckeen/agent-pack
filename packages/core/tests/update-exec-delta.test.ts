import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeExecDelta,
  exportPack,
  TARGET_PLATFORMS,
  type AdapterOutputFile,
  type TargetPlatform,
} from "../src/index.js";
import type { InstallManifestV1 } from "../src/install/types.js";

// #153: the update re-consent delta derives its exec-surface classification
// from the plan/adapters, not from a global hardcoded path regex — the same
// shape #119/#152 landed for the install gate. Written files carry the
// adapter-stamped `execCapable`; removals ask the recorded target's adapter.
// Gating expectations here are COMPUTED from adapter output wherever an
// adapter output exists, so a target that later gains (or loses) an
// exec-capable surface flips these assertions instead of silently detaching
// the update gate.

const BANG_BASH = /!`/;

const tmpRoot = path.join(os.tmpdir(), `agentpack-update-exec-delta-${Date.now()}`);
let packDir: string;

function manifestStub(
  target: TargetPlatform,
  opts: { scope?: "user"; atomIds?: string[] } = {},
): InstallManifestV1 {
  return {
    atomIds: opts.atomIds ?? [],
    target,
    ...(opts.scope ? { scope: opts.scope } : {}),
  } as unknown as InstallManifestV1;
}

async function writePack(): Promise<string> {
  const dir = path.join(tmpRoot, "pack");
  await fs.mkdir(path.join(dir, "atoms/commands/prompts"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "AGENTPACK.yaml"),
    `agentpack: "1.0"

metadata:
  id: "agentpack.update-exec-delta-fixture"
  name: "Update Exec Delta Fixture"
  slug: "update-exec-delta-fixture"
  description: "Test pack: a command atom whose body carries a Claude Code bang-bash directive (#153)."
  version: "0.1.0"
  license: "MIT"
  publisher: "agentpack"
  authors:
    - name: "AgentPack"
      email: "hello@agentpack.dev"
  tags:
    - test

compatibility:
  targets:
    claude-code:
      status: supported

permissions:
  filesystem:
    read:
      - "."
    write:
      - "."
  package_installation: false
  model_provider_key_access: false

security:
  risk_level: low
  risk_summary: "Low declared risk — but the command body ships an executable directive."
  requires_review: false
  signed: false

profiles:
  full:
    description: "All atoms."
    include:
      - "*"

atoms:
  - id: "command:deploy"
    type: command
    name: "Deploy"
    description: "Probe command whose body embeds a bang-bash directive."
    path: "atoms/commands/deploy.yaml"
    risk_level: low
    invocation:
      slash: "/deploy"
      cli: "deploy"
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "atoms/commands/deploy.yaml"),
    `id: deploy
name: Deploy
invocation:
  slash: "/deploy"
  cli: "deploy"
prompt: atoms/commands/prompts/deploy.md
output:
  format: markdown
`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "atoms/commands/prompts/deploy.md"),
    "# Deploy\n\nSummarize the deploy, then run this immediately: !`echo deployed`\n",
    "utf8",
  );
  return dir;
}

async function exportFiles(target: TargetPlatform): Promise<AdapterOutputFile[]> {
  const outDir = path.join(tmpRoot, `out-${target}`);
  const result = await exportPack({
    source: packDir,
    target,
    profile: "full",
    outDir,
  });
  return result.plan.files;
}

beforeAll(async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  packDir = await writePack();
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("update re-consent derives written-side exec surfaces from the plan (#153)", () => {
  it.each(TARGET_PLATFORMS)(
    "%s: a fresh-plan bang-bash command write re-consents iff the adapter stamped an exec-capable file",
    async (target) => {
      const files = await exportFiles(target);
      const expectGate = files.some(
        (f) => f.execCapable === true && BANG_BASH.test(f.content),
      );
      const delta = computeExecDelta({
        priorManifest: manifestStub(target),
        atomTypes: [{ id: "command:deploy", type: "command" }],
        writtenFiles: files,
        removedPaths: [],
      });
      expect(delta.execSurfaceWrites.length > 0).toBe(expectGate);
      expect(delta.addedExecAtoms).toHaveLength(0);
    },
  );

  it("at least claude-code re-consents on the bang-bash command write (anti-vacuity)", async () => {
    const files = await exportFiles("claude-code");
    const delta = computeExecDelta({
      priorManifest: manifestStub("claude-code"),
      atomTypes: [{ id: "command:deploy", type: "command" }],
      writtenFiles: files,
      removedPaths: [],
    });
    expect(delta.execSurfaceWrites).toContain(".claude/commands/deploy.md");
  });

  it("a hypothetical adapter layout change cannot detach the gate: the plan's execCapable flag decides, not the path", () => {
    // No legacy path regex matches this path — under the pre-#153 classifier
    // this write would silently skip re-consent while the surface stays live.
    const delta = computeExecDelta({
      priorManifest: manifestStub("claude-code"),
      atomTypes: [],
      writtenFiles: [
        {
          path: "totally/new/layout/deploy.md",
          content: "Run !`rm -rf /` on invocation",
          execCapable: true,
        },
      ],
      removedPaths: [],
    });
    expect(delta.execSurfaceWrites).toEqual(["totally/new/layout/deploy.md"]);
  });

  it("a bang-bash body the adapter stamped NOT exec-capable is not gated, even at the legacy regex path", () => {
    // The adapter is the authority (#119): if the target runtime does not
    // execute directives in this file, a path that LOOKS like an exec surface
    // must not re-consent.
    const delta = computeExecDelta({
      priorManifest: manifestStub("generic"),
      atomTypes: [],
      writtenFiles: [
        {
          path: ".claude/commands/deploy.md",
          content: "Run !`rm -rf /` on invocation",
          execCapable: false,
        },
      ],
      removedPaths: [],
    });
    expect(delta.execSurfaceWrites).toHaveLength(0);
  });
});

describe("update re-consent classifies removals via the recorded target's adapter (#153)", () => {
  it("removing a previously-exec command body triggers the delta (project scope)", () => {
    const delta = computeExecDelta({
      priorManifest: manifestStub("claude-code"),
      atomTypes: [],
      writtenFiles: [],
      removedPaths: [".claude/commands/deploy.md"],
    });
    expect(delta.execSurfaceWrites).toEqual([".claude/commands/deploy.md"]);
  });

  it("removing a previously-exec command body triggers the delta at the user-scope layout", () => {
    // --scope user records the REMAPPED path (`.claude/` prefix stripped);
    // the classifier must still reach the adapter's declaration.
    const delta = computeExecDelta({
      priorManifest: manifestStub("claude-code", { scope: "user" }),
      atomTypes: [],
      writtenFiles: [],
      removedPaths: ["commands/deploy.md"],
    });
    expect(delta.execSurfaceWrites).toEqual(["commands/deploy.md"]);
  });

  it("removing a launch-config surface still triggers the delta (.mcp.json / .codex/config.toml)", () => {
    const claude = computeExecDelta({
      priorManifest: manifestStub("claude-code"),
      atomTypes: [],
      writtenFiles: [],
      removedPaths: [".mcp.json"],
    });
    expect(claude.execSurfaceWrites).toEqual([".mcp.json"]);

    const codex = computeExecDelta({
      priorManifest: manifestStub("codex"),
      atomTypes: [],
      writtenFiles: [],
      removedPaths: [".codex/config.toml"],
    });
    expect(codex.execSurfaceWrites).toEqual([".codex/config.toml"]);
  });

  it("non-exec targets do not gate removals of command-shaped or foreign-target paths", () => {
    const delta = computeExecDelta({
      priorManifest: manifestStub("generic"),
      atomTypes: [],
      writtenFiles: [],
      removedPaths: ["commands/deploy.md", "agentpack.json", "skills/notes/SKILL.md"],
    });
    expect(delta.execSurfaceWrites).toHaveLength(0);
  });

  it("a codex config.toml WRITE gates only when the pack ships mcp_server atoms (metadata-only rewrites stay frictionless)", () => {
    // codex emits `.codex/config.toml` for EVERY pack (agentpack metadata),
    // so an unconditional write match would force --allow-exec on every
    // codex update. Without mcp atoms the file carries no command lines.
    const metadataOnly = computeExecDelta({
      priorManifest: manifestStub("codex"),
      atomTypes: [{ id: "command:deploy", type: "command" }],
      writtenFiles: [
        { path: ".codex/config.toml", content: "[agentpack]\n", execCapable: false },
      ],
      removedPaths: [],
    });
    expect(metadataOnly.execSurfaceWrites).toHaveLength(0);

    const withMcp = computeExecDelta({
      priorManifest: manifestStub("codex", { atomIds: ["mcp_server:x"] }),
      atomTypes: [{ id: "mcp_server:x", type: "mcp_server" }],
      writtenFiles: [
        {
          path: ".codex/config.toml",
          content: '[mcp_servers.x]\ncommand = "node"\n',
          execCapable: false,
        },
      ],
      removedPaths: [],
    });
    expect(withMcp.execSurfaceWrites).toEqual([".codex/config.toml"]);
  });

  it("launch-config surfaces are scoped per target: another target's config path does not gate", () => {
    // Pre-#153 the regex was global — a generic-target removal of
    // `.codex/config.toml` (a file that target never emitted) still gated.
    const delta = computeExecDelta({
      priorManifest: manifestStub("generic"),
      atomTypes: [],
      writtenFiles: [],
      removedPaths: [".codex/config.toml", ".mcp.json"],
    });
    expect(delta.execSurfaceWrites).toHaveLength(0);
  });
});
