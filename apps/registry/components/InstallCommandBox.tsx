"use client";

import { useState } from "react";

interface Props {
  packId: string;
  publisher: string;
  slug: string;
  target?: string;
  profile?: string;
}

export function InstallCommandBox({
  publisher,
  slug,
  target = "claude-code",
  profile = "safe",
}: Props) {
  const sourcePath = `examples/${slug}`;
  const cmd = `npx workgraph pack export ${sourcePath} --target ${target} --profile ${profile} --out dist/${target}`;
  const validateCmd = `npx workgraph validate ${sourcePath}`;
  return (
    <div className="space-y-3">
      <CopyableLine label="Validate" cmd={validateCmd} />
      <CopyableLine label="Export" cmd={cmd} />
      <p className="text-xs text-ink-400">
        From your project root. Once installation lands, the equivalent will be{" "}
        <code className="font-mono">workgraph install {publisher}/{slug}</code>.
      </p>
    </div>
  );
}

function CopyableLine({ label, cmd }: { label: string; cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-ink-400 mb-1">
        {label}
      </div>
      <div className="flex items-stretch gap-0">
        <pre className="codeblock flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-r-none">
          {cmd}
        </pre>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(cmd);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch {
              // ignore; clipboard may be blocked
            }
          }}
          className="rounded-r-lg bg-ink-800 px-3 text-xs font-semibold text-ink-50 hover:bg-ink-700"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
