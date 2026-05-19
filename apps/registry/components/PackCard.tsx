import Link from "next/link";
import type { SeedPack } from "@agentpack/core";
import { RiskBadge } from "./RiskBadge";

export function PackCard({ pack }: { pack: SeedPack }) {
  return (
    <Link
      href={`/packs/${pack.publisher}/${pack.slug}`}
      className="card flex h-full flex-col gap-4 transition hover:border-accent-400"
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-400">
            {pack.publisher}
          </div>
          <h3 className="mt-0.5 text-lg font-semibold text-ink-900">
            {pack.name}
          </h3>
        </div>
        <RiskBadge level={pack.riskLevel} />
      </div>
      <p className="text-sm text-ink-600">{pack.description}</p>
      <div className="mt-auto flex flex-wrap gap-1.5">
        {pack.tags.map((t) => (
          <span key={t} className="pill">
            #{t}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs text-ink-400">
        {pack.atomTypes.map((t) => (
          <span key={t} className="rounded bg-ink-50 px-1.5 py-0.5">
            {t}
          </span>
        ))}
      </div>
    </Link>
  );
}
