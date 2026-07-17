import pc from "picocolors";
import type {
  InstallPlan,
  PermissionSummary,
  RiskLevel,
  ValidationResult,
} from "@agentpack/core";

const RISK_COLOR: Record<RiskLevel, (s: string) => string> = {
  low: pc.green,
  medium: pc.yellow,
  high: pc.red,
  critical: (s) => pc.bgRed(pc.white(s)),
};

export function riskBadge(level: RiskLevel): string {
  // RISK_COLOR is a total record over the RiskLevel union; the lookup is
  // always defined. `noUncheckedIndexedAccess` widens to `| undefined` so
  // we narrow with `!`.
  const colorize = RISK_COLOR[level]!;
  return colorize(` ${level.toUpperCase()} `);
}

export function header(text: string): string {
  return pc.bold(pc.cyan(text));
}

export function renderValidation(result: ValidationResult): string {
  const lines: string[] = [];
  if (result.valid) {
    lines.push(pc.green("✓ Manifest is valid."));
  } else {
    lines.push(pc.red(`✗ Manifest is invalid (${result.errors.length} error(s)):`));
  }
  for (const err of result.errors) {
    lines.push(
      `  ${pc.red("•")} ${pc.bold(err.code)} at ${pc.dim(err.path || "(root)")}: ${err.message}`,
    );
  }
  for (const w of result.warnings) {
    lines.push(
      `  ${pc.yellow("•")} ${pc.bold(w.code)} at ${pc.dim(w.path || "(root)")}: ${w.message}`,
    );
  }
  return lines.join("\n");
}

export function renderPermissionSummary(p: PermissionSummary): string {
  const grouped: Record<RiskLevel, string[]> = {
    low: [],
    medium: [],
    high: [],
    critical: [],
  };
  for (const entry of p.flat) {
    const line =
      `  • ${pc.bold(entry.category)}: ${entry.description}` +
      (entry.atomIds.length ? pc.dim(` (atoms: ${entry.atomIds.join(", ")})`) : "");
    grouped[entry.riskLevel]!.push(line);
  }
  const lines: string[] = [];
  for (const level of ["critical", "high", "medium", "low"] as const) {
    const bucket = grouped[level]!;
    if (bucket.length === 0) continue;
    lines.push(`${riskBadge(level)} ${pc.bold(`${level.toUpperCase()} RISK`)}`);
    lines.push(...bucket);
  }
  if (p.secrets.length > 0) {
    lines.push("");
    lines.push(pc.bold("Required secrets:"));
    for (const s of p.secrets) {
      lines.push(
        `  • ${pc.cyan(s.name)}${s.description ? ` — ${s.description}` : ""}` +
          (s.requiredFor.length
            ? pc.dim(` (required for: ${s.requiredFor.join(", ")})`)
            : ""),
      );
    }
  }
  if (p.domains.length > 0) {
    lines.push("");
    lines.push(pc.bold("Network domains:"));
    for (const d of p.domains) lines.push(`  • ${pc.cyan(d)}`);
  }
  if (p.shellCommands.length > 0) {
    lines.push("");
    lines.push(pc.bold("Declared shell commands:"));
    for (const c of p.shellCommands) lines.push(`  • ${pc.magenta(c)}`);
  }
  if (lines.length === 0) lines.push(pc.dim("  (no permissions requested)"));
  return lines.join("\n");
}

export function renderInstallPlan(plan: InstallPlan): string {
  const lines: string[] = [];
  lines.push(
    header(`${plan.packId}@${plan.packVersion}`) +
      `  →  target: ${pc.cyan(plan.target)}   profile: ${pc.cyan(plan.profile)}   risk: ${riskBadge(plan.riskLevel)}`,
  );
  // Authored claim vs compiler-observed result (#134) — reported separately
  // so the manifest's claim never masks what the adapter actually achieved.
  lines.push(
    `Compatibility: authored ${plan.authoredCompatibility ?? "(undeclared)"} · observed ${plan.observedFidelity}`,
  );
  lines.push("");
  lines.push(pc.bold(`Atoms (${plan.atoms.length})`));
  for (const a of plan.atoms) lines.push(`  • ${a}`);
  if (plan.unsupportedAtoms.length > 0) {
    lines.push("");
    lines.push(pc.bold(pc.yellow("Unsupported by adapter:")));
    for (const a of plan.unsupportedAtoms) lines.push(`  • ${pc.dim(a)}`);
  }
  lines.push("");
  lines.push(pc.bold("Permissions"));
  lines.push(renderPermissionSummary(plan.permissions));
  lines.push("");
  lines.push(pc.bold(`Files (${plan.files.length})`));
  for (const f of plan.files) {
    lines.push(`  • ${pc.green("+")} ${f.path} ${pc.dim(`(${f.action})`)}`);
  }
  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push(pc.bold(pc.yellow("Warnings")));
    for (const w of plan.warnings) lines.push(`  ${pc.yellow("!")} ${w}`);
  }
  return lines.join("\n");
}
