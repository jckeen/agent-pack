/**
 * Pack-detail signature badge.
 *
 *   - Has a signature  →  green "Signed by <SAN>" with link to Rekor entry.
 *   - No signature     →  muted "Unsigned".
 *
 * Designed to slot next to RiskBadge in the pack detail header. Identity is
 * the SAN URI from the Fulcio cert; we trim the `https://github.com/`
 * prefix when present so the badge stays short.
 */

interface SignatureInfo {
  san: string;
  issuer: string;
  rekorLogUrl: string;
  signedAt: string;
}

export function SignatureBadge({
  signature,
  size = "sm",
}: {
  signature: SignatureInfo | null;
  size?: "sm" | "md";
}) {
  const sizing = size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm";

  if (!signature) {
    return (
      <span
        className={`inline-flex items-center rounded-full border font-medium uppercase tracking-wide bg-zinc-50 text-zinc-500 border-zinc-200 ${sizing}`}
        title="This version is not Sigstore-signed."
      >
        Unsigned
      </span>
    );
  }

  const displaySAN = signature.san
    .replace(/^https:\/\/github\.com\//, "@")
    .replace(/^https:\/\//, "");
  return (
    <a
      href={signature.rekorLogUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium tracking-wide bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 ${sizing}`}
      title={`Signed by ${signature.san} via Sigstore on ${signature.signedAt}. Click to view Rekor entry.`}
    >
      <svg
        viewBox="0 0 16 16"
        className="h-3 w-3 fill-current"
        aria-hidden="true"
      >
        <path d="M8 0L1 3v5c0 4.418 3.582 7.582 7 8 3.418-.418 7-3.582 7-8V3L8 0zm-.5 11.5L4 8l1.5-1.5L7.5 8.5l3-3L12 7l-4.5 4.5z" />
      </svg>
      <span>Signed by {displaySAN}</span>
    </a>
  );
}
