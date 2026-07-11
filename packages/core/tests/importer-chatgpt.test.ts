import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseChatgptGpt,
  buildChatgptManifest,
  importChatgptGptDir,
  writeImport,
  validateManifest,
  agentPackManifestSchema,
  exportChat,
  KNOWLEDGE_RAG_WARNING,
} from "../src/index.js";
import { parse as parseYaml } from "yaml";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/chatgpt",
);

const OPTS = { id: "acme.support-triage", name: "Support Triage" };

/** Build a virtual bundle (relPath → content) for pure-parser tests. */
function tree(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files));
}

describe("parseChatgptGpt", () => {
  it("parses gpt.json fields", () => {
    const parsed = parseChatgptGpt(
      tree({
        "gpt.json": JSON.stringify({
          name: "X",
          description: "d",
          instructions: "## Tone\n\nbe kind",
          conversation_starters: ["a", "b"],
        }),
      }),
    );
    expect(parsed.name).toBe("X");
    expect(parsed.description).toBe("d");
    expect(parsed.conversationStarters).toEqual(["a", "b"]);
    expect(parsed.parsedInstructions?.sections.map((s) => s.heading)).toEqual(["Tone"]);
  });

  it("transpiles an inline openapi action", () => {
    const parsed = parseChatgptGpt(
      tree({
        "gpt.json": JSON.stringify({ name: "X", instructions: "## A\n\nx" }),
        "openapi.yaml":
          "info:\n  title: API\npaths:\n  /x:\n    get:\n      operationId: getX\n",
      }),
    );
    expect(parsed.action?.tools.map((t) => t.name)).toEqual(["getX"]);
  });

  it("collects knowledge files", () => {
    const parsed = parseChatgptGpt(
      tree({
        "gpt.json": JSON.stringify({ name: "X", instructions: "## A\n\nx" }),
        "knowledge/a.md": "alpha",
        "knowledge/sub/b.txt": "beta",
      }),
    );
    expect(parsed.knowledge.map((k) => k.relPath)).toEqual(["a.md", "sub/b.txt"]);
  });

  it("warns when gpt.json is missing or malformed rather than throwing", () => {
    expect(
      parseChatgptGpt(tree({})).warnings.some((w) => /gpt\.json/.test(w.message)),
    ).toBe(true);
    const bad = parseChatgptGpt(tree({ "gpt.json": "{not json" }));
    expect(bad.warnings.some((w) => /Failed to parse gpt\.json/.test(w.message))).toBe(
      true,
    );
  });
});

describe("buildChatgptManifest", () => {
  it("emits a schema-valid, semantically-valid manifest from the fixture", async () => {
    const parsed = await readFixture();
    const { manifest } = buildChatgptManifest(parsed, OPTS);
    expect(() => agentPackManifestSchema.parse(manifest)).not.toThrow();
    const validation = validateManifest(manifest);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("keeps lossy ChatGPT imports experimental", async () => {
    const parsed = await readFixture();
    const { manifest } = buildChatgptManifest(parsed, OPTS);
    expect(manifest.compatibility.targets.chatgpt?.status).toBe("experimental");
    expect(manifest.compatibility.targets.codex?.status).toBe("partial");
    expect(manifest.compatibility.targets.codex?.notes).toMatch(/compiled.*verify/i);
  });

  it("maps instructions → instruction + rule atoms (governance split)", async () => {
    const parsed = await readFixture();
    const { manifest } = buildChatgptManifest(parsed, OPTS);
    const types = new Set(manifest.atoms.map((a) => a.type));
    expect(types.has("instruction")).toBe(true);
    expect(types.has("rule")).toBe(true);
    // The fixture's `## Security` heading is a governance rule.
    expect(manifest.atoms.some((a) => a.type === "rule" && /security/i.test(a.name))).toBe(
      true,
    );
  });

  it("maps conversation_starters → a Suggested prompts instruction atom", async () => {
    const parsed = await readFixture();
    const { manifest } = buildChatgptManifest(parsed, OPTS);
    expect(
      manifest.atoms.some(
        (a) => a.type === "instruction" && a.name === "Suggested prompts",
      ),
    ).toBe(true);
  });

  it("transpiles the Action into a connector-shaped mcp_server atom", async () => {
    const parsed = await readFixture();
    const { manifest, files } = buildChatgptManifest(parsed, OPTS);
    const mcp = manifest.atoms.find((a) => a.type === "mcp_server");
    expect(mcp).toBeDefined();
    expect((mcp as { transport?: string }).transport).toBe("http");
    expect((mcp as { url?: string }).url).toContain("https://");
    // Declared through permissions.mcp.servers + secrets (apiKey fixture).
    expect(manifest.permissions?.mcp?.servers?.length).toBe(1);
    expect((manifest.permissions?.secrets?.required ?? []).length).toBeGreaterThan(0);
    // The atom-body YAML carries the transpiled tool catalogue + auth block.
    const mcpFile = files.find((f) => f.relativePath.startsWith("atoms/mcp/"))!;
    const body = parseYaml(mcpFile.content) as {
      tools: unknown[];
      auth: { scheme: string };
    };
    expect(body.tools.length).toBe(3);
    expect(body.auth.scheme).toBe("apiKey");
  });

  it("maps knowledge → a context_pack atom and surfaces the LOUD RAG warning", async () => {
    const parsed = await readFixture();
    const { manifest, warnings } = buildChatgptManifest(parsed, OPTS);
    expect(manifest.atoms.some((a) => a.type === "context_pack")).toBe(true);
    expect(warnings.some((w) => w.message.includes(KNOWLEDGE_RAG_WARNING))).toBe(true);
  });

  it("emits no validator warnings about undeclared mcp secrets", async () => {
    const parsed = await readFixture();
    const { manifest } = buildChatgptManifest(parsed, OPTS);
    const codes = validateManifest(manifest).warnings.map((w) => w.code);
    expect(codes).not.toContain("permission.declared_secrets_missing");
  });

  it("prefixes every atom id with its type", async () => {
    const parsed = await readFixture();
    const { manifest } = buildChatgptManifest(parsed, OPTS);
    for (const atom of manifest.atoms) {
      expect(atom.id.startsWith(`${atom.type}:`)).toBe(true);
    }
  });

  it("falls back to a single instruction atom when instructions have no sections", () => {
    const parsed = parseChatgptGpt(
      tree({
        "gpt.json": JSON.stringify({
          name: "Flat",
          instructions: "just prose, no headings",
        }),
      }),
    );
    const { manifest } = buildChatgptManifest(parsed, OPTS);
    expect(manifest.atoms.some((a) => a.type === "instruction")).toBe(true);
    expect(() => agentPackManifestSchema.parse(manifest)).not.toThrow();
  });

  it("throws when the bundle yields no atoms", () => {
    const parsed = parseChatgptGpt(tree({ "gpt.json": JSON.stringify({ name: "Empty" }) }));
    expect(() => buildChatgptManifest(parsed, OPTS)).toThrow(/nothing to import/i);
  });
});

describe("importChatgptGptDir (I/O + chat compile)", () => {
  it("imports the fixture tree into a validatable pack", async () => {
    const result = await importChatgptGptDir(FIXTURE_DIR, OPTS);
    const manifestFile = result.files.find((f) => f.relativePath === "AGENTPACK.yaml")!;
    const parsedManifest = parseYaml(manifestFile.content);
    expect(() => agentPackManifestSchema.parse(parsedManifest)).not.toThrow();
    const validation = validateManifest(parsedManifest);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("emits the expected atom files (instructions, mcp, knowledge copy)", async () => {
    const result = await importChatgptGptDir(FIXTURE_DIR, OPTS);
    const paths = result.files.map((f) => f.relativePath);
    expect(paths.some((p) => p.startsWith("atoms/instructions/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("atoms/mcp/"))).toBe(true);
    expect(paths).toContain("atoms/context/knowledge/refund-policy.md");
    expect(paths).toContain("atoms/context/knowledge/escalation.txt");
  });

  it("surfaces the knowledge RAG warning on import", async () => {
    const result = await importChatgptGptDir(FIXTURE_DIR, OPTS);
    expect(result.warnings.some((w) => w.message.includes(KNOWLEDGE_RAG_WARNING))).toBe(
      true,
    );
  });

  it("compiles through `pack chat` into Skill + connector + project artifacts", async () => {
    const result = await importChatgptGptDir(FIXTURE_DIR, OPTS);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-import-"));
    const out = path.join(dir, "chat");
    try {
      await writeImport(result, dir);
      const chat = await exportChat({ source: dir, outDir: out });
      // The transpiled connector reaches Chat as a remote connector.
      expect(chat.connectors.length).toBe(1);
      expect(chat.connectors[0]!.transport).toBe("http");
      expect(chat.connectors[0]!.auth.scheme).toBe("apiKey");
      // Instructions/rules bridge to on-invoke skills + project instructions.
      expect(chat.skills.length).toBeGreaterThan(0);
      expect(chat.writtenFiles).toContain("project-instructions.md");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("is traversal-proof: every emitted path stays inside the pack", async () => {
    const result = await importChatgptGptDir(FIXTURE_DIR, OPTS);
    for (const file of result.files) {
      expect(path.isAbsolute(file.relativePath)).toBe(false);
      expect(file.relativePath.split(/[\\/]+/)).not.toContain("..");
    }
  });
});

async function readFixture() {
  const map = new Map<string, string>();
  async function walk(rel: string) {
    const abs = path.join(FIXTURE_DIR, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(childRel);
      else
        map.set(
          childRel.split(path.sep).join("/"),
          await fs.readFile(path.join(abs, e.name), "utf8"),
        );
    }
  }
  await walk("");
  return parseChatgptGpt(map);
}
