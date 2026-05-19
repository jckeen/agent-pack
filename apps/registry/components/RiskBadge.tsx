import type { RiskLevel } from "@agentpack/core";

const RISK_CLASS: Record<RiskLevel, string> = {
  low: "bg-emerald-50 text-emerald-700 border-emerald-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  high: "bg-red-50 text-red-700 border-red-200",
  critical: "bg-red-900 text-white border-red-900",
};

export function RiskBadge({
  level,
  size = "sm",
}: {
  level: RiskLevel;
  size?: "sm" | "md";
}) {
  const cls = RISK_CLASS[level];
  const sizing =
    size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm";
  return (
    <span
      className={`inline-flex items-center rounded-full border font-medium uppercase tracking-wide ${cls} ${sizing}`}
    >
      {level}
    </span>
  );
}
