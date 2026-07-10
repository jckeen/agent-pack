import { resolveLatestVersion, type RegistryClient } from "@agentpack/core";

/**
 * The "latest published stable version" policy, shared by `install` (version
 * resolution when no version is requested) and `update --check` (comparison
 * target for latest-channel registry sources). One definition so the two can
 * never drift — if this rule changes (e.g. prerelease channels), both verbs
 * move together.
 */
export async function latestPublishedVersion(
  client: RegistryClient,
  publisher: string,
  pack: string,
): Promise<string | null> {
  const pkg = await client.listVersions(publisher, pack);
  const published = pkg.versions
    .filter((v) => v.status === "published")
    .map((v) => v.version);
  return resolveLatestVersion(published) ?? null;
}
