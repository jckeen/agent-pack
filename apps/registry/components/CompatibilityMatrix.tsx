import type { CompatibilityStatus, TargetPlatform } from "@agentpack/core";

const STATUS_STYLES: Record<CompatibilityStatus, { dot: string; label: string }> = {
  supported: { dot: "bg-emerald-500", label: "Supported" },
  partial: { dot: "bg-amber-400", label: "Partial" },
  experimental: { dot: "bg-sky-400", label: "Experimental" },
  unsupported: { dot: "bg-ink-200", label: "Unsupported" },
};

const TARGET_ORDER: TargetPlatform[] = [
  "claude-code",
  "codex",
  "cursor",
  "chatgpt",
  "generic",
];

const TARGET_LABEL: Record<TargetPlatform, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  chatgpt: "ChatGPT Apps",
  generic: "Generic / AGENTS.md",
};

export function CompatibilityMatrix({
  targets,
  notes,
}: {
  targets: Partial<Record<TargetPlatform, CompatibilityStatus>>;
  notes?: Partial<Record<TargetPlatform, string>>;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-ink-100">
      <table className="w-full text-sm">
        <thead className="bg-ink-50 text-ink-400">
          <tr>
            <th className="px-4 py-2 text-left font-medium uppercase tracking-wider text-xs">
              Target
            </th>
            <th className="px-4 py-2 text-left font-medium uppercase tracking-wider text-xs">
              Status
            </th>
            <th className="px-4 py-2 text-left font-medium uppercase tracking-wider text-xs">
              Notes
            </th>
          </tr>
        </thead>
        <tbody>
          {TARGET_ORDER.map((target) => {
            const status = targets[target] ?? "unsupported";
            const style = STATUS_STYLES[status];
            return (
              <tr key={target} className="border-t border-ink-100">
                <td className="px-4 py-2 font-medium text-ink-900">
                  {TARGET_LABEL[target]}
                </td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${style.dot}`}
                      aria-hidden
                    />
                    <span className="text-ink-600">{style.label}</span>
                  </span>
                </td>
                <td className="px-4 py-2 text-ink-400">
                  {notes?.[target] ?? ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
