/**
 * Renders a red, prominent banner on the pack detail page when the active
 * version's status is `quarantined`. Replaces InstallCommandBox per
 * ROADMAP D4.4 + session ISA ISC-11.
 */

interface QuarantineBannerProps {
  publisher: string;
  pack: string;
  version: string;
  reason: string | null;
}

export function QuarantineBanner({
  publisher,
  pack,
  version,
  reason,
}: QuarantineBannerProps) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 p-5"
      data-testid="quarantine-banner"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white"
        >
          !
        </span>
        <h3 className="text-base font-semibold text-red-900">
          This version has been quarantined
        </h3>
      </div>

      <p className="mt-2 text-sm text-red-800">
        <code className="font-mono">
          {publisher}/{pack}@{version}
        </code>{" "}
        has been marked unsafe to install by its publisher and the registry is
        refusing to serve it.
      </p>

      {reason && (
        <p className="mt-2 text-sm text-red-800">
          <span className="font-semibold">Reason:</span> {reason}
        </p>
      )}

      <p className="mt-3 text-xs text-red-700">
        If you have already installed this version,{" "}
        <code className="font-mono">agentpack verify --sig</code> will warn,
        and the registry will return HTTP 451 on any new install attempt. See{" "}
        <a
          href="/docs/security"
          className="underline underline-offset-2 hover:no-underline"
        >
          security docs
        </a>{" "}
        for the full quarantine semantics.
      </p>
    </div>
  );
}
