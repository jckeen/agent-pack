"use client";

import { useMemo, useState } from "react";
import type { RiskLevel, SeedPack, TargetPlatform } from "@agentpack/core";
import { PackCard } from "@/components/PackCard";

const RISK_FILTERS: Array<{ label: string; value: RiskLevel | "all" }> = [
  { label: "All", value: "all" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Critical", value: "critical" },
];

const TARGET_FILTERS: Array<{ label: string; value: TargetPlatform | "any" }> = [
  { label: "Any platform", value: "any" },
  { label: "Claude Code", value: "claude-code" },
  { label: "Codex", value: "codex" },
  { label: "Cursor", value: "cursor" },
  { label: "ChatGPT", value: "chatgpt" },
  { label: "Generic", value: "generic" },
];

export function PacksBrowser({
  packs,
  tags,
}: {
  packs: SeedPack[];
  tags: string[];
}) {
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeRisk, setActiveRisk] = useState<RiskLevel | "all">("all");
  const [activeTarget, setActiveTarget] = useState<TargetPlatform | "any">(
    "any",
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return packs.filter((p) => {
      if (activeRisk !== "all" && p.riskLevel !== activeRisk) return false;
      if (activeTag && !p.tags.includes(activeTag)) return false;
      if (activeTarget !== "any") {
        const status = p.platforms[activeTarget];
        if (status === "unsupported" || !status) return false;
      }
      if (!q) return true;
      const haystack = [
        p.name,
        p.id,
        p.description,
        p.publisher,
        p.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [packs, query, activeTag, activeRisk, activeTarget]);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr]">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search packs by name, description, tag…"
          className="w-full rounded-lg border border-ink-200 bg-white px-4 py-2 text-sm shadow-soft focus:border-accent-500 focus:outline-hidden"
        />
        <select
          value={activeRisk}
          onChange={(e) => setActiveRisk(e.target.value as RiskLevel | "all")}
          className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm shadow-soft focus:border-accent-500 focus:outline-hidden"
        >
          {RISK_FILTERS.map((r) => (
            <option key={r.value} value={r.value}>
              Risk: {r.label}
            </option>
          ))}
        </select>
        <select
          value={activeTarget}
          onChange={(e) =>
            setActiveTarget(e.target.value as TargetPlatform | "any")
          }
          className="rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm shadow-soft focus:border-accent-500 focus:outline-hidden"
        >
          {TARGET_FILTERS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setActiveTag(null)}
          className={`pill ${
            activeTag === null ? "ring-2 ring-accent-500" : ""
          }`}
        >
          All tags
        </button>
        {tags.map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => setActiveTag((current) => (current === t ? null : t))}
            className={`pill ${
              activeTag === t ? "ring-2 ring-accent-500" : ""
            }`}
          >
            #{t}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ink-200 p-10 text-center text-ink-400">
          No packs match those filters.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <PackCard key={p.id} pack={p} />
          ))}
        </div>
      )}
    </div>
  );
}
