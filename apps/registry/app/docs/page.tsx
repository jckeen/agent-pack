import Link from "next/link";

const SECTIONS = [
  {
    title: "AgentPack standard",
    body: "An AgentPack is a portable, installable bundle of AI agent behavior. The manifest is `AGENTPACK.yaml`. Each pack is composed of atoms — instruction, rule, skill, hook, command, subagent, mcp_server, plugin, workflow, context_pack, template, eval. Profiles (safe / standard / full / enterprise) select which atoms install.",
    link: "/docs#standard",
  },
  {
    title: "Security model",
    body: "Risk is computed from atom risk levels, required permissions, and the install profile. Permission summaries are first-class — no silent capability escalation. Hooks, secrets, MCP servers, and shell execution always surface as warnings.",
    link: "/docs#security",
  },
  {
    title: "Adapters",
    body: "AgentPack compiles to Claude Code (CLAUDE.md, .claude/skills, .claude/agents, .claude/settings.json), Codex (AGENTS.md, .codex/config.toml, .codex/hooks.json, .codex/skills), Cursor (.cursor/rules, .cursor/mcp.json, AGENTS.md), ChatGPT Apps (project-instructions.md, MCP app skeleton), and Generic (AGENTS.md, skills/, README-agent.md, agentpack.json).",
    link: "/docs#adapters",
  },
  {
    title: "CLI",
    body: "The workgraph CLI: init, validate, inspect, plan, pack export, doctor, install, uninstall, diff, history, rollback, verify. `pack export` is pure (writes only under --out). `install` writes into your project root after showing a diff and prompting — backs up overwritten files, writes AGENTPACK.lock with per-atom SHA-256 checksums, and tracks every action in `.workgraph/history.jsonl` (hash-chained, WAL-protected).",
    link: "/docs#cli",
  },
  {
    title: "Install / uninstall / verify (Phase 2)",
    body: "`workgraph install` is the local install flow: diff against project root → permission summary → confirm → backup → write → install manifest at `.workgraph/installed/<pack>.json` → AGENTPACK.lock → history append. `workgraph uninstall` reverses it (delete created, restore backups). `workgraph verify` computes on-disk SHA-256 against the lockfile and reports drift. `workgraph rollback` undoes the most recent install (or all installs after a given history id with --to). The hash chain in `history.jsonl` makes the audit log tamper-evident.",
    link: "/docs#install",
  },
];

export default function DocsPage() {
  return (
    <div className="container-page space-y-10">
      <header className="space-y-2">
        <span className="pill-accent">Documentation</span>
        <h1 className="h1">Workgraph Registry Documentation</h1>
        <p className="max-w-2xl text-ink-600">
          The AgentPack standard, security model, adapter behavior, and the
          workgraph CLI — at a glance.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {SECTIONS.map((s) => (
          <div key={s.title} className="card">
            <h2 className="text-base font-semibold text-ink-900">{s.title}</h2>
            <p className="mt-2 text-sm text-ink-600">{s.body}</p>
          </div>
        ))}
      </div>

      <section id="standard" className="card space-y-3">
        <h2 className="h2">Anatomy of an AgentPack</h2>
        <p className="text-sm text-ink-600">
          Every pack has a manifest, a set of atoms, install profiles, and a
          compatibility table:
        </p>
        <pre className="codeblock overflow-x-auto whitespace-pre text-xs">{`agentpack: "1.0"

metadata:
  id: "your-publisher.your-pack"
  name: "Your Pack"
  version: "0.1.0"
  publisher: "your-publisher"

compatibility:
  targets:
    claude-code:
      status: supported

profiles:
  safe:
    include: [ "instruction:project-defaults" ]
  full:
    include: [ "*" ]

atoms:
  - id: "instruction:project-defaults"
    type: instruction
    name: "Project Defaults"
    description: "Default project guidance for agents."
    path: "atoms/instructions/project-defaults.md"
    risk_level: low
`}</pre>
      </section>

      <section id="security" className="card space-y-3">
        <h2 className="h2">Security and permissions</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-600">
          <li>Hook atoms are <strong>always high risk</strong> — they run shell commands after edits.</li>
          <li>MCP servers requiring secrets escalate to high.</li>
          <li>Shell + secrets + network + filesystem.write together raises the plan to critical.</li>
          <li>Safe profile excludes hooks, MCP servers, and shell-executing atoms.</li>
          <li>The CLI never writes outside the <code className="font-mono">--out</code> directory.</li>
        </ul>
      </section>

      <section id="adapters" className="card space-y-3">
        <h2 className="h2">Adapter outputs</h2>
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-ink-400">
            <tr>
              <th className="py-2 text-left">Target</th>
              <th className="py-2 text-left">Files written</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            <Row name="Claude Code" files="CLAUDE.md · .claude/skills/* · .claude/agents/* · .claude/settings.json" />
            <Row name="Codex" files="AGENTS.md · .codex/config.toml · .codex/hooks.json · .codex/skills/* · .codex/agents/*" />
            <Row name="Cursor" files="AGENTS.md · .cursor/rules/*.mdc · .cursor/mcp.json" />
            <Row name="ChatGPT Apps" files="project-instructions.md · app-manifest.json · mcp-server/* (export-only stub)" />
            <Row name="Generic" files="AGENTS.md · skills/* · README-agent.md · agentpack.json" />
          </tbody>
        </table>
      </section>

      <section id="cli" className="card space-y-3">
        <h2 className="h2">CLI commands</h2>
        <pre className="codeblock overflow-x-auto whitespace-pre text-xs">{`workgraph init                  # scaffold a starter AGENTPACK.yaml
workgraph validate [path]       # validate a manifest
workgraph inspect [path]        # print metadata, atoms, profiles, risk
workgraph plan [path] \\
    --target <t> --profile <p>  # plan + risk + permission summary
workgraph pack export [path] \\
    --target <t> --profile <p> \\
    --out <dir>                 # write platform-native files
workgraph doctor                # environment checks
`}</pre>
        <p className="text-sm text-ink-400">
          <Link className="text-accent-700 hover:underline" href="/packs">
            Browse the registry →
          </Link>
        </p>
      </section>
    </div>
  );
}

function Row({ name, files }: { name: string; files: string }) {
  return (
    <tr>
      <td className="py-2 font-medium text-ink-900">{name}</td>
      <td className="py-2 font-mono text-xs text-ink-600">{files}</td>
    </tr>
  );
}
