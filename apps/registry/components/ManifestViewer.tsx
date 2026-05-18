"use client";

import { useState } from "react";

export function ManifestViewer({ yaml }: { yaml: string }) {
  const [open, setOpen] = useState(false);
  const preview = yaml.split("\n").slice(0, 14).join("\n");
  const truncated = yaml.split("\n").length > 14;
  return (
    <div className="rounded-xl border border-ink-100">
      <div className="flex items-center justify-between border-b border-ink-100 bg-ink-50 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-400">
          AGENTPACK.yaml
        </span>
        {truncated && (
          <button
            type="button"
            className="text-xs font-semibold text-accent-700 hover:text-accent-600"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Collapse" : "Show full manifest"}
          </button>
        )}
      </div>
      <pre className="overflow-x-auto bg-ink-900 px-4 py-3 font-mono text-xs leading-relaxed text-ink-50">
        {open ? yaml : preview}
        {!open && truncated ? "\n…" : ""}
      </pre>
    </div>
  );
}
