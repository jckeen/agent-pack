import type { PermissionSummary as PermissionSummaryType, RiskLevel } from "@agentpack/core";

const RISK_ORDER: RiskLevel[] = ["critical", "high", "medium", "low"];

const RISK_HEADER: Record<RiskLevel, { label: string; cls: string }> = {
  critical: { label: "Critical risk", cls: "bg-red-900 text-white" },
  high: { label: "High risk", cls: "bg-red-50 text-red-700 border border-red-200" },
  medium: { label: "Medium risk", cls: "bg-amber-50 text-amber-700 border border-amber-200" },
  low: { label: "Low risk", cls: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
};

export function PermissionSummary({
  summary,
}: {
  summary: PermissionSummaryType;
}) {
  const grouped = new Map<RiskLevel, PermissionSummaryType["flat"]>();
  for (const e of summary.flat) {
    const list = grouped.get(e.riskLevel) ?? [];
    list.push(e);
    grouped.set(e.riskLevel, list);
  }

  if (summary.flat.length === 0) {
    return (
      <p className="text-sm text-ink-400">
        No permissions are requested for this profile.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {RISK_ORDER.map((level) => {
        const items = grouped.get(level);
        if (!items || items.length === 0) return null;
        const hdr = RISK_HEADER[level];
        return (
          <section key={level}>
            <div
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider ${hdr.cls}`}
            >
              {hdr.label}
            </div>
            <ul className="mt-2 space-y-1.5 text-sm text-ink-700">
              {items.map((e) => (
                <li key={e.category}>
                  <span className="font-mono text-xs text-ink-400">
                    {e.category}
                  </span>{" "}
                  — {e.description}
                  {e.atomIds.length > 0 && (
                    <span className="ml-1 text-ink-400">
                      (from {e.atomIds.join(", ")})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {summary.secrets.length > 0 && (
        <section>
          <h4 className="h3">Secrets required</h4>
          <ul className="mt-2 space-y-1 text-sm text-ink-700">
            {summary.secrets.map((s) => (
              <li key={s.name}>
                <span className="font-mono text-xs">{s.name}</span>
                {s.description ? ` — ${s.description}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
      {summary.domains.length > 0 && (
        <section>
          <h4 className="h3">Network domains</h4>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {summary.domains.map((d) => (
              <li key={d} className="pill">
                {d}
              </li>
            ))}
          </ul>
        </section>
      )}
      {summary.shellCommands.length > 0 && (
        <section>
          <h4 className="h3">Declared shell commands</h4>
          <ul className="mt-2 space-y-1 text-sm">
            {summary.shellCommands.map((c) => (
              <li key={c} className="font-mono text-xs text-ink-700">
                $ {c}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
