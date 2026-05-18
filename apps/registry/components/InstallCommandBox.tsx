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
  const installCmd = `npx workgraph install ${sourcePath} --target ${target} --profile ${profile}`;
  const exportCmd = `npx workgraph pack export ${sourcePath} --target ${target} --profile ${profile} --out dist/${target}`;
  const validateCmd = `npx workgraph validate ${sourcePath}`;
  const verifyCmd = `npx workgraph verify ${publisher}.${slug}`;
  return (
    <div className="space-y-3">
      <CopyableLine label="Validate" cmd={validateCmd} />
      <CopyableLine label="Install (writes to your project, with diff + lockfile)" cmd={installCmd} />
      <CopyableLine label="Export only (no install, writes to dist/)" cmd={exportCmd} />
      <CopyableLine label="Verify (drift detection)" cmd={verifyCmd} />
      <p className="text-xs text-ink-400">
        From your project root. <code className="font-mono">install</code> prints a diff and prompts before
        writing; pass <code className="font-mono">--dry-run</code> to preview, <code className="font-mono">--yes</code> to skip the prompt, or{" "}
        <code className="font-mono">--force</code> to overwrite files without an AgentPack marker.
        The lockfile (<code className="font-mono">AGENTPACK.lock</code>) is committed; everything else under{" "}
        <code className="font-mono">.workgraph/</code> is per-machine.
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
