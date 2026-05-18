"use client";

import { useState, useTransition } from "react";
import { runValidation, type ValidatePayload } from "./actions";

const PLACEHOLDER = `agentpack: "1.0"

metadata:
  id: "your-publisher.your-pack"
  name: "Your Pack"
  slug: "your-pack"
  description: "What this pack does."
  version: "0.1.0"
  publisher: "your-publisher"

compatibility:
  targets:
    claude-code:
      status: supported

profiles:
  safe:
    description: "Instructions only."
    include:
      - "instruction:defaults"

atoms:
  - id: "instruction:defaults"
    type: instruction
    name: "Defaults"
    description: "Project defaults."
    path: "atoms/instructions/defaults.md"
    risk_level: low
`;

export function ValidateForm() {
  const [yaml, setYaml] = useState("");
  const [payload, setPayload] = useState<ValidatePayload | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-2">
        <label className="h3" htmlFor="yaml-input">
          AGENTPACK.yaml
        </label>
        <textarea
          id="yaml-input"
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          rows={26}
          className="w-full rounded-lg border border-ink-200 bg-white p-3 font-mono text-xs leading-relaxed shadow-soft focus:border-accent-500 focus:outline-none"
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pending}
            className="rounded-md bg-ink-900 px-4 py-2 text-sm font-semibold text-white shadow-soft hover:bg-ink-800 disabled:opacity-50"
            onClick={() => {
              startTransition(async () => {
                const result = await runValidation(yaml);
                setPayload(result);
              });
            }}
          >
            {pending ? "Validating…" : "Validate"}
          </button>
          <button
            type="button"
            className="rounded-md border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
            onClick={() => {
              setYaml(PLACEHOLDER);
              setPayload(null);
            }}
          >
            Insert example
          </button>
        </div>
      </div>
      <div className="space-y-3">
        <h2 className="h3">Result</h2>
        {!payload && (
          <p className="rounded-xl border border-dashed border-ink-200 p-6 text-sm text-ink-400">
            Paste a manifest on the left and click Validate. Results appear here.
          </p>
        )}
        {payload?.parseError && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <div className="font-semibold">YAML parse error</div>
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">
              {payload.parseError}
            </pre>
          </div>
        )}
        {payload?.result?.valid === true && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
            <div className="font-semibold">✓ Manifest is valid.</div>
            {payload.result.warnings.length > 0 && (
              <div className="mt-2 text-amber-700">
                {payload.result.warnings.length} warning(s) — see below.
              </div>
            )}
          </div>
        )}
        {payload?.result?.valid === false && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <div className="font-semibold">
              ✗ {payload.result.errors.length} error(s)
            </div>
            <ul className="mt-2 space-y-1">
              {payload.result.errors.map((e, i) => (
                <li key={i}>
                  <span className="font-mono text-xs">{e.code}</span> at{" "}
                  <span className="font-mono text-xs">{e.path || "(root)"}</span>:{" "}
                  {e.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {payload?.result?.warnings.length ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <div className="font-semibold">
              ! {payload.result.warnings.length} warning(s)
            </div>
            <ul className="mt-2 space-y-1">
              {payload.result.warnings.map((w, i) => (
                <li key={i}>
                  <span className="font-mono text-xs">{w.code}</span> — {w.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
