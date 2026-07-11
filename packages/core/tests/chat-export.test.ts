import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unzipSync, strFromU8 } from "fflate";

import { exportChat } from "../src/exports/exportChat.js";
import { validateSkillMdContent } from "../src/skills/agentskills.js";

const FIXTURE = path.resolve(__dirname, "fixtures/chat-pack");

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agentpack-chat-"));
}

/** Read an emitted skill ZIP into a {path -> string} map. */
async function readZip(file: string): Promise<Record<string, string>> {
  const bytes = await fs.readFile(file);
  const entries = unzipSync(new Uint8Array(bytes));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(entries)) out[k] = strFromU8(v);
  return out;
}

describe("exportChat", () => {
  it("emits one uploadable, spec-conformant skill ZIP per skill atom", async () => {
    const out = await tmp();
    const result = await exportChat({ source: FIXTURE, profile: "full", outDir: out });

    const dataCleanup = result.skills.find((s) => s.atomId === "skill:data-cleanup");
    expect(dataCleanup).toBeTruthy();
    expect(dataCleanup!.kind).toBe("native");
    expect(dataCleanup!.zipPath.endsWith(".zip")).toBe(true);
    await expect(fs.stat(dataCleanup!.zipPath)).resolves.toBeTruthy();

    // The ZIP holds SKILL.md under a single top-level dir matching the name.
    const entries = await readZip(dataCleanup!.zipPath);
    const skillMdKey = Object.keys(entries).find((k) => k.endsWith("/SKILL.md"));
    expect(skillMdKey).toBeTruthy();
    const dir = skillMdKey!.split("/")[0]!;
    expect(dir).toBe("data-cleanup");

    // It passes Agent Skills conformance (name = dir, ≤64 / desc ≤ limits).
    const skillMd = entries[skillMdKey!]!;
    expect(validateSkillMdContent(skillMd, dir)).toEqual([]);

    await fs.rm(out, { recursive: true, force: true });
  });

  it("compiles instruction/rule/procedure-command atoms into on-invoke skill ZIPs, flagged on-invoke", async () => {
    const out = await tmp();
    const result = await exportChat({ source: FIXTURE, profile: "full", outDir: out });

    const onInvoke = result.skills.filter((s) => s.kind === "on-invoke");
    const ids = onInvoke.map((s) => s.atomId).sort();
    expect(ids).toEqual([
      "command:triage",
      "instruction:writing-style",
      "rule:no-secrets-in-logs",
    ]);

    // Each on-invoke skill is a valid, uploadable ZIP that passes conformance.
    for (const s of onInvoke) {
      const entries = await readZip(s.zipPath);
      const key = Object.keys(entries).find((k) => k.endsWith("/SKILL.md"))!;
      const dir = key.split("/")[0]!;
      expect(validateSkillMdContent(entries[key]!, dir)).toEqual([]);
      // Honest flag: on-invoke skills must announce they are NOT ambient.
      expect(entries[key]!.toLowerCase()).toContain("on-invoke");
    }

    await fs.rm(out, { recursive: true, force: true });
  });

  it("emits connectors.json for remote mcp_server atoms with URL, auth, scopes, and an org checklist", async () => {
    const out = await tmp();
    await exportChat({ source: FIXTURE, profile: "full", outDir: out });

    const connectorsPath = path.join(out, "connectors.json");
    await expect(fs.stat(connectorsPath)).resolves.toBeTruthy();
    const doc = JSON.parse(await fs.readFile(connectorsPath, "utf8"));

    expect(Array.isArray(doc.connectors)).toBe(true);
    const tickets = doc.connectors.find(
      (c: { atom: string }) => c.atom === "mcp_server:tickets",
    );
    expect(tickets).toBeTruthy();
    expect(tickets.url).toBe("https://mcp.example.com/tickets");
    expect(tickets.transport).toBe("http");
    expect(tickets.auth.scheme).toBe("oauth2");
    expect(tickets.auth.scopes).toEqual(["tickets:read", "tickets:write"]);
    // Install recipe (copy-paste/QR) + org-provisioning checklist note.
    expect(typeof tickets.install_recipe).toBe("string");
    expect(tickets.install_recipe).toContain("https://mcp.example.com/tickets");
    expect(typeof doc.org_provisioning_checklist).toBe("string");
    expect(doc.org_provisioning_checklist.length).toBeGreaterThan(0);

    await fs.rm(out, { recursive: true, force: true });
  });

  it("refuses Codex-only MCP policy instead of widening it into a Chat connector", async () => {
    const source = await tmp();
    const out = await tmp();
    await fs.cp(FIXTURE, source, { recursive: true });
    const manifestPath = path.join(source, "AGENTPACK.yaml");
    const manifest = await fs.readFile(manifestPath, "utf8");
    await fs.writeFile(
      manifestPath,
      manifest.replace(
        '    url: "https://mcp.example.com/tickets"',
        '    url: "https://mcp.example.com/tickets"\n    codex_only_config:\n      - enabled\n      - enabled_tools',
      ),
    );

    const result = await exportChat({ source, profile: "full", outDir: out });
    expect(result.connectors).toEqual([]);
    expect(result.report.find((entry) => entry.atomId === "mcp_server:tickets")).toEqual(
      expect.objectContaining({ portable: false }),
    );
    await expect(fs.stat(path.join(out, "connectors.json"))).rejects.toBeTruthy();

    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
  });

  it("emits project-instructions.md from instruction/rule atoms", async () => {
    const out = await tmp();
    await exportChat({ source: FIXTURE, profile: "full", outDir: out });

    const md = await fs.readFile(path.join(out, "project-instructions.md"), "utf8");
    expect(md).toContain("Writing Style");
    expect(md).toContain("active voice");
    // Rules surface in the instructions block too.
    expect(md).toContain("No Secrets In Logs");

    await fs.rm(out, { recursive: true, force: true });
  });

  it("writes an install README with a per-atom portability report marking non-portable atoms", async () => {
    const out = await tmp();
    const result = await exportChat({ source: FIXTURE, profile: "full", outDir: out });

    const readme = await fs.readFile(path.join(out, "README.md"), "utf8");
    // Ordered install steps.
    expect(readme).toMatch(/## .*Install/i);
    // Portability report: subagent/hook flagged not-portable-to-chat.
    expect(readme).toMatch(/subagent:reviewer/);
    expect(readme).toMatch(/hook:on-save/);
    expect(readme.toLowerCase()).toContain("not portable");

    // Structured report: command downgraded to on-invoke skill, subagent/hook dropped.
    const report = new Map(result.report.map((r) => [r.atomId, r]));
    expect(report.get("subagent:reviewer")!.portable).toBe(false);
    expect(report.get("hook:on-save")!.portable).toBe(false);
    expect(report.get("command:triage")!.downgradedTo).toBe("skill");
    expect(report.get("skill:data-cleanup")!.portable).toBe(true);

    await fs.rm(out, { recursive: true, force: true });
  });

  it("works with the safe profile (no connector) without throwing", async () => {
    const out = await tmp();
    const result = await exportChat({ source: FIXTURE, profile: "safe", outDir: out });
    // No remote connector in safe → no connectors.json.
    await expect(fs.stat(path.join(out, "connectors.json"))).rejects.toBeTruthy();
    expect(result.skills.length).toBeGreaterThan(0);
    await fs.rm(out, { recursive: true, force: true });
  });
});
