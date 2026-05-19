/**
 * Pick the highest non-pre-release semver from a list. Returns null if list
 * is empty or every entry is a pre-release.
 *
 * Pre-release detection: any version with a `-` after the major.minor.patch
 * (e.g. `1.2.0-beta.1`, `0.1.0-rc.1`) is considered pre-release.
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function resolveLatestVersion(versions: string[]): string | null {
  const stable = versions
    .map((v) => ({ version: v, match: v.match(SEMVER_RE) }))
    .filter(
      (entry): entry is { version: string; match: RegExpMatchArray } =>
        entry.match !== null && entry.match[4] === undefined
    );

  if (stable.length === 0) return null;

  stable.sort((a, b) => {
    for (let i = 1; i <= 3; i += 1) {
      const diff = Number(b.match[i]) - Number(a.match[i]);
      if (diff !== 0) return diff;
    }
    return 0;
  });

  return stable[0]?.version ?? null;
}
