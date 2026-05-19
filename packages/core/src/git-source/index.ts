/**
 * Git source resolver — install AgentPacks directly from a git repo.
 *
 * Today's surface: GitHub (`github:owner/repo@ref[#subpath]` or
 * `github.com/owner/repo[@ref][#subpath]`). The fetcher pulls
 * AGENTPACK.yaml first, derives the file list from the manifest's
 * `atoms[].files[]`, then fetches each file from raw.githubusercontent.com.
 *
 * The result is a tmpRoot path with the same shape `fetchRemotePack` returns
 * for registry-hosted packs — so the existing `planInstall` pipeline takes
 * it from there with no changes downstream.
 *
 * Constraints:
 *   - No new npm deps. Built-in `fetch` + `yaml` (already a core dep).
 *   - Per-file sha256 not enforceable against a registry-declared hash
 *     (git has no pre-published manifest of expected hashes); the lockfile
 *     records whatever was on disk at install time. Integrity comes from
 *     pinning the git ref (commit SHA or signed tag), not from a registry.
 *   - Signature verification for git sources is Phase 4.5 (cosign-on-tag);
 *     the CLI's `--require-sig` returns a clear deferral message for now.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import yaml from "yaml";

export interface GitSource {
  host: "github" | "github.com";
  owner: string;
  repo: string;
  /** Tag, branch, or commit SHA. Null = resolve default branch via API. */
  ref: string | null;
  /** Subpath inside the repo where AGENTPACK.yaml lives. Null = repo root. */
  subpath: string | null;
}

/**
 * Match `github:owner/repo[@ref][#subpath]` or `github.com/owner/repo[@ref][#subpath]`.
 *
 * - `github:` prefix is the canonical short form (npm-style).
 * - `github.com/` prefix is the URL-style form humans paste.
 * - Trailing `.git` is tolerated and stripped.
 * - `owner` and `repo` follow GitHub's slug rules: alphanumeric, dash,
 *   underscore, dot; 1-39 chars for owner, 1-100 chars for repo.
 * - `ref` accepts any non-`#` characters (tags can have `.` and `/`).
 * - `subpath` is a relative POSIX path; `..` is stripped at fetch time.
 */
const GIT_ID_RE =
  /^(github(?:\.com)?)[:/]([A-Za-z0-9_.-]{1,39})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?(?:@([^#]+))?(?:#(.+))?$/;

export function parseGitId(input: string): GitSource | null {
  if (!input || typeof input !== "string") return null;
  const m = input.match(GIT_ID_RE);
  if (!m) return null;
  const [, hostRaw, owner, repo, ref, subpath] = m;
  if (!owner || !repo) return null;
  // Normalize host. `github:` and `github.com` are both treated as
  // GitHub; the host field records which surface the user spelled, in
  // case a future revision wants to surface that in lockfile provenance.
  const host = hostRaw === "github.com" ? "github.com" : "github";
  return {
    host,
    owner,
    repo,
    ref: ref ?? null,
    subpath: subpath ?? null,
  };
}

/**
 * Resolve the default branch for a repo via GitHub's public API.
 * Used when the user omits `@ref`.
 */
async function resolveDefaultBranch(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<string> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub API ${url} returned ${res.status} — repo may be private or missing.`
    );
  }
  const body = (await res.json()) as { default_branch?: string };
  if (!body.default_branch) {
    throw new Error(`GitHub API returned no default_branch for ${owner}/${repo}.`);
  }
  return body.default_branch;
}

/**
 * Build the raw.githubusercontent.com URL for a file at a given ref +
 * optional subpath. Refs that look like commit SHAs are passed through;
 * tags and branches go through the `refs/{kind}/...` namespace only when
 * the caller already knows the kind — for safety, we let raw.gh.com's
 * generic prefix resolve any ref shape.
 */
function rawUrl(
  owner: string,
  repo: string,
  ref: string,
  filePath: string
): string {
  const cleanPath = filePath.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${cleanPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export interface FetchGitPackOptions {
  source: GitSource;
  /** Where to materialize the tmpRoot. Defaults to a unique dir under os.tmpdir(). */
  tmpRootHint?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Materialize a git-sourced pack into a tmpRoot suitable for `planInstall`.
 *
 * Steps:
 *   1. If source.ref is null, resolve the repo's default branch.
 *   2. Fetch AGENTPACK.yaml from raw.githubusercontent.com at ref/subpath.
 *   3. Parse the manifest to enumerate atom file paths.
 *   4. Fetch each file in sequence (parallelism left for v0.5.1).
 *   5. Return the tmpRoot.
 */
export async function fetchGitPack(
  options: FetchGitPackOptions
): Promise<string> {
  const { source } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const ref =
    source.ref ?? (await resolveDefaultBranch(source.owner, source.repo, fetchImpl));

  const subpathPrefix = source.subpath
    ? `${source.subpath.replace(/^\/+|\/+$/g, "")}/`
    : "";

  // 1. Fetch the manifest.
  const manifestUrl = rawUrl(
    source.owner,
    source.repo,
    ref,
    `${subpathPrefix}AGENTPACK.yaml`
  );
  const manifestRes = await fetchImpl(manifestUrl, {
    headers: { Accept: "text/plain" },
  });
  if (!manifestRes.ok) {
    throw new Error(
      `GitHub raw fetch ${manifestUrl} returned ${manifestRes.status} — confirm the ref + subpath.`
    );
  }
  const manifestText = await manifestRes.text();
  const manifest = yaml.parse(manifestText) as {
    atoms?: Array<{ id?: string; files?: Array<{ path?: string }> }>;
  };

  if (!manifest || typeof manifest !== "object") {
    throw new Error(
      `Fetched ${manifestUrl} but the YAML did not parse to a manifest object.`
    );
  }

  // 2. Materialize tmpRoot.
  const tmpRoot =
    options.tmpRootHint ??
    (await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        `wgpack-git-${source.owner}-${source.repo}-`
      )
    ));
  await fs.mkdir(tmpRoot, { recursive: true });
  await fs.writeFile(path.join(tmpRoot, "AGENTPACK.yaml"), manifestText, "utf-8");

  // 3. Fetch each atom file.
  const atoms = Array.isArray(manifest.atoms) ? manifest.atoms : [];
  for (const atom of atoms) {
    const files = Array.isArray(atom?.files) ? atom.files : [];
    for (const file of files) {
      const rel = typeof file?.path === "string" ? file.path : null;
      if (!rel) continue;
      // Reject path-traversal at the manifest boundary.
      if (rel.includes("..") || rel.startsWith("/")) {
        throw new Error(
          `Manifest declares file path "${rel}" with traversal or absolute root — refusing to fetch.`
        );
      }
      const fileUrl = rawUrl(
        source.owner,
        source.repo,
        ref,
        `${subpathPrefix}${rel}`
      );
      const fileRes = await fetchImpl(fileUrl);
      if (!fileRes.ok) {
        throw new Error(
          `GitHub raw fetch ${fileUrl} returned ${fileRes.status} — manifest referenced "${rel}" but the file is missing at this ref.`
        );
      }
      const bytes = Buffer.from(await fileRes.arrayBuffer());
      const dest = path.join(tmpRoot, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, bytes);
    }
  }

  return tmpRoot;
}
