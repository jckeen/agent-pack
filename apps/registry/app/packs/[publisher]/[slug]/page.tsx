import { notFound } from "next/navigation";
import Link from "next/link";
import { SEED_PACKS, getSeedPack } from "@/lib/seed";
import { getPackDetail } from "@/lib/manifest";
import { CompatibilityMatrix } from "@/components/CompatibilityMatrix";
import { RiskBadge } from "@/components/RiskBadge";
import { SignatureBadge } from "@/components/SignatureBadge";
import { PermissionSummary } from "@/components/PermissionSummary";
import { InstallCommandBox } from "@/components/InstallCommandBox";
import { QuarantineBanner } from "@/components/QuarantineBanner";
import { AtomList } from "@/components/AtomList";
import { ManifestViewer } from "@/components/ManifestViewer";
import { getLatestSignatureForPack } from "@/lib/signatures";
import { getVersionStatus } from "@/lib/version-status";

export async function generateStaticParams() {
  return SEED_PACKS.map((p) => ({
    publisher: p.publisher,
    slug: p.slug,
  }));
}

export default async function PackDetailPage({
  params,
}: {
  params: Promise<{ publisher: string; slug: string }>;
}) {
  const { publisher, slug } = await params;
  const seed = getSeedPack(publisher, slug);
  if (!seed) notFound();

  const detail = await getPackDetail(seed);
  const signature = await getLatestSignatureForPack(
    seed.publisher,
    seed.slug,
    seed.version
  );
  const versionStatus = await getVersionStatus(
    seed.publisher,
    seed.slug,
    seed.version
  );
  const isQuarantined = versionStatus?.status === "quarantined";
  const profiles = detail.manifest
    ? Object.keys(detail.manifest.profiles)
    : ["safe"];
  const defaultProfile =
    detail.manifest?.exports?.default_profile ?? profiles[0] ?? "safe";

  const manifestTargets = detail.manifest?.compatibility.targets;
  const compatStatuses = manifestTargets
    ? Object.fromEntries(
        Object.entries(manifestTargets).map(([k, v]) => [k, v?.status]),
      )
    : seed.platforms;
  const compatNotes = manifestTargets
    ? Object.fromEntries(
        Object.entries(manifestTargets).map(([k, v]) => [k, v?.notes ?? ""]),
      )
    : {};

  return (
    <div className="container-page space-y-10">
      <header className="flex flex-col gap-4">
        <div className="text-sm text-ink-400">
          <Link href="/packs" className="hover:text-ink-600">
            Registry
          </Link>{" "}
          / <span className="text-ink-600">{seed.publisher}</span>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="h1">{seed.name}</h1>
            <p className="mt-2 max-w-2xl text-ink-600">{seed.description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {seed.tags.map((t) => (
                <span key={t} className="pill">
                  #{t}
                </span>
              ))}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              <SignatureBadge signature={signature} size="md" />
              <RiskBadge level={detail.riskLevel} size="md" />
            </div>
            <span className="text-xs text-ink-400">
              v{seed.version} · {seed.publisher}
            </span>
          </div>
        </div>
      </header>

      <section className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <div className="card space-y-4">
          <h2 className="h2">Install</h2>
          {isQuarantined ? (
            <QuarantineBanner
              publisher={seed.publisher}
              pack={seed.slug}
              version={seed.version}
              reason={versionStatus?.reason ?? null}
            />
          ) : (
            <InstallCommandBox
              packId={seed.id}
              publisher={seed.publisher}
              slug={seed.slug}
              target="claude-code"
              profile={defaultProfile}
            />
          )}
        </div>
        <div className="card space-y-2">
          <h2 className="h2">Profiles</h2>
          <ul className="space-y-2 text-sm text-ink-600">
            {profiles.map((p) => {
              const spec = detail.manifest?.profiles[p];
              return (
                <li key={p}>
                  <span className="font-mono text-xs text-ink-900">{p}</span>
                  {spec?.description ? ` — ${spec.description}` : null}
                </li>
              );
            })}
            {profiles.length === 0 && (
              <li className="text-ink-400">No profile data available.</li>
            )}
          </ul>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="h2">Compatibility</h2>
        <CompatibilityMatrix
          targets={compatStatuses as Parameters<typeof CompatibilityMatrix>[0]["targets"]}
          notes={compatNotes as Parameters<typeof CompatibilityMatrix>[0]["notes"]}
        />
      </section>

      <section className="space-y-3">
        <h2 className="h2">Permission summary</h2>
        <PermissionPicker
          profiles={profiles}
          defaultProfile={defaultProfile}
          summaries={detail.permissionsByProfile}
        />
      </section>

      <section className="space-y-3">
        <h2 className="h2">Atoms</h2>
        {detail.manifest ? (
          <AtomList atoms={detail.manifest.atoms} />
        ) : (
          <p className="text-sm text-ink-400">
            No live manifest is available for this pack yet. Seed metadata only.
          </p>
        )}
      </section>

      {detail.rawYaml && (
        <section className="space-y-3">
          <h2 className="h2">Manifest preview</h2>
          <ManifestViewer yaml={detail.rawYaml} />
        </section>
      )}

      {detail.validation && (
        <section className="space-y-3">
          <h2 className="h2">Validation</h2>
          {detail.validation.valid ? (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              ✓ Manifest validates clean.
            </p>
          ) : (
            <ul className="space-y-1 text-sm text-red-700">
              {detail.validation.errors.map((e, i) => (
                <li key={i}>
                  <span className="font-mono text-xs">{e.code}</span> — {e.message}
                </li>
              ))}
            </ul>
          )}
          {detail.validation.warnings.length > 0 && (
            <ul className="space-y-1 text-sm text-amber-700">
              {detail.validation.warnings.map((w, i) => (
                <li key={i}>! {w.message}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

// Inline client component to switch between profile permission views.
function PermissionPicker({
  profiles,
  defaultProfile,
  summaries,
}: {
  profiles: string[];
  defaultProfile: string;
  summaries: Awaited<ReturnType<typeof getPackDetail>>["permissionsByProfile"];
}) {
  if (Object.keys(summaries).length === 0) {
    return (
      <p className="text-sm text-ink-400">
        Permission previews are only available for packs with a live manifest.
      </p>
    );
  }
  // Server-rendered, but allow the user to expand each profile.
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {profiles.map((p) => {
        const summary = summaries[p];
        if (!summary) return null;
        return (
          <div
            key={p}
            className={`card space-y-3 ${p === defaultProfile ? "ring-1 ring-accent-500" : ""}`}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-ink-900">
                Profile: <span className="font-mono text-sm">{p}</span>
              </h3>
              {p === defaultProfile && (
                <span className="pill-accent">Default</span>
              )}
            </div>
            <PermissionSummary summary={summary} />
          </div>
        );
      })}
    </div>
  );
}
