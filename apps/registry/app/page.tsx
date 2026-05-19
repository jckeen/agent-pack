import Link from "next/link";
import { SEED_PACKS } from "@/lib/seed";
import { PackCard } from "@/components/PackCard";

export default function HomePage() {
  const featured = SEED_PACKS.slice(0, 6);
  return (
    <div className="container-page space-y-16">
      <section className="grid items-center gap-10 md:grid-cols-[1.4fr,1fr]">
        <div>
          <span className="pill-accent">AgentPack standard · v1.0</span>
          <h1 className="h1 mt-3">
            Atomic packages for AI workflows.
            <br />
            <span className="text-ink-400">Write once. Install anywhere agents work.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-600">
            AgentPack is an open packaging standard for AI agent behavior.
            One <code className="font-mono text-sm">AGENTPACK.yaml</code> compiles to Claude
            Code, Codex, Cursor, ChatGPT Apps, and a generic AGENTS.md
            target — with permissions and risk visible before you install.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href="/packs"
              className="rounded-md bg-ink-900 px-4 py-2 text-sm font-semibold text-white shadow-soft hover:bg-ink-800"
            >
              Browse the registry
            </Link>
            <Link
              href="/docs"
              className="rounded-md border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-800 hover:bg-ink-50"
            >
              Read the standard
            </Link>
            <Link
              href="/validate"
              className="rounded-md border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-800 hover:bg-ink-50"
            >
              Validate a manifest
            </Link>
          </div>
        </div>
        <div className="card flex flex-col gap-3 bg-ink-900 text-ink-50">
          <span className="text-xs uppercase tracking-wider text-ink-400">
            CLI quickstart
          </span>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
{`# Validate a pack
npx agentpack validate examples/pr-quality

# Plan an install for Claude Code, safe profile
npx agentpack plan examples/pr-quality \\
  --target claude-code --profile safe

# Export to native files
npx agentpack pack export examples/pr-quality \\
  --target claude-code --profile safe \\
  --out dist/claude`}
          </pre>
        </div>
      </section>

      <section className="space-y-6">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="h2">Featured packs</h2>
            <p className="text-sm text-ink-400">
              Curated AgentPacks across editor, review, and team-workflow surfaces.
            </p>
          </div>
          <Link
            href="/packs"
            className="text-sm font-semibold text-accent-700 hover:text-accent-600"
          >
            View all {SEED_PACKS.length} packs →
          </Link>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {featured.map((p) => (
            <PackCard key={p.id} pack={p} />
          ))}
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        <Pillar
          title="Compile, don't replace"
          body="Targets existing platform standards: CLAUDE.md, AGENTS.md, .cursor/rules, MCP. AgentPack is the layer above, not another silo."
        />
        <Pillar
          title="Permission transparency"
          body="Every pack lists what it can read, write, run, and connect to — broken down by install profile, before you say yes."
        />
        <Pillar
          title="Built for supply chain"
          body="Atoms, lockfiles, checksums, and review states. Treat agent customization like every other dependency in your repo."
        />
      </section>
    </div>
  );
}

function Pillar({ title, body }: { title: string; body: string }) {
  return (
    <div className="card">
      <h3 className="text-base font-semibold text-ink-900">{title}</h3>
      <p className="mt-2 text-sm text-ink-600">{body}</p>
    </div>
  );
}
