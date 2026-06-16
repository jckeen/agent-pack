/**
 * Git source resolver — install AgentPacks directly from a git repo.
 *
 * Today's surface: GitHub (`github:owner/repo@ref[#subpath]` or
 * `github.com/owner/repo[@ref][#subpath]`). The fetcher pins the ref to a
 * commit SHA, lists the repo tree at that SHA via the GitHub git/trees API,
 * and materializes EVERY file under the pack subpath from
 * raw.githubusercontent.com — manifest, atom bodies, skill directories,
 * referenced prompt files, checksums, all of it. (An earlier revision fetched
 * only `atoms[].files[]`, a field the schema's `atom.path` packs never set,
 * which silently produced empty packs — codex P0-2.)
 *
 * The result is a tmpRoot path with the same shape `fetchRemotePack` returns
 * for registry-hosted packs — so the existing `planInstall` pipeline takes
 * it from there with no changes downstream.
 *
 * Auth: `GITHUB_TOKEN` / `GH_TOKEN` is sent when present — enables
 * private-repo installs and lifts the anonymous api.github.com rate limit.
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
 * - `subpath` is a relative POSIX path; `..` and absolute paths are rejected.
 */
const GIT_ID_RE =
  /^(github(?:\.com)?)[:/]([A-Za-z0-9_.-]{1,39})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?(?:@([^#]+))?(?:#(.+))?$/;

/**
 * Allowed characters in a git ref. Mirrors the safe subset of `git
 * check-ref-format` rules:
 *   - letters, digits, `.`, `_`, `-`, `/`, `+` (semver build metadata
 *     like `v1.0.0+build.1` is a real-world case)
 *   - rejects every C0/C1 control char (newline, CR, NUL etc.) and the
 *     shell metacharacters that would smuggle into log lines or the
 *     raw.gh.com URL path
 *   - rejects spaces and `~`, `^`, `:`, `?`, `*`, `[`, backslash,
 *     apostrophe (all forbidden by git itself)
 * Cap at 255 chars — GitHub's effective ref-name limit is below this.
 * From security-reviewer HIGH-4 (iter-5); widened in codex P2 review to
 * allow `+`.
 */
const REF_RE = /^[A-Za-z0-9._/+-]{1,255}$/;

export function parseGitId(input: string): GitSource | null {
  if (!input || typeof input !== "string") return null;
  const m = input.match(GIT_ID_RE);
  if (!m) return null;
  const [, hostRaw, owner, repo, ref, subpath] = m;
  if (!owner || !repo) return null;
  // Validate ref shape if present. A ref containing newlines, NUL, or other
  // control characters can be injected into log output (CLI prints `ref`
  // directly) and can construct a malformed raw.githubusercontent.com URL
  // even after percent-encoding. Reject loudly rather than coerce.
  if (ref !== undefined && !REF_RE.test(ref)) return null;
  // Subpath sanitization: reject control chars, absolute paths, and `..`
  // segments here — a traversal subpath must never reach the URL builder or
  // the tree filter (security-reviewer LOW-1 / codex P2-2).
  if (subpath !== undefined) {
    if (/[\x00-\x1f\x7f]/.test(subpath)) return null;
    if (subpath.startsWith("/") || subpath.startsWith("~")) return null;
    if (subpath.split("/").includes("..")) return null;
  }
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
 * Auth token for GitHub fetches. `GITHUB_TOKEN` (Actions convention) or
 * `GH_TOKEN` (gh CLI convention). Enables private-repo installs and lifts
 * the 60-requests/hour anonymous api.github.com rate limit.
 */
function githubToken(): string | undefined {
  return process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? undefined;
}

function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = githubToken();
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Translate a failed GitHub response into an actionable error. A
 * non-interactive agent needs to know WHICH recovery path applies: auth,
 * waiting out a rate limit, or fixing the ref/path.
 */
function describeGitHubFailure(res: Response, url: string, context: string): Error {
  const hasToken = githubToken() !== undefined;
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  if ((res.status === 403 || res.status === 429) && remaining === "0") {
    const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : "(unknown)";
    return new Error(
      `GitHub rate limit exceeded while ${context} (${url}). Limit resets at ${resetAt}. ` +
        (hasToken
          ? "Wait for the reset or use a token with more quota."
          : "Set GITHUB_TOKEN to raise the anonymous 60 requests/hour limit."),
    );
  }
  if (res.status === 401) {
    return new Error(
      `GitHub rejected the provided token (401) while ${context} (${url}). Check GITHUB_TOKEN/GH_TOKEN.`,
    );
  }
  if (res.status === 404 || res.status === 403) {
    return new Error(
      `GitHub returned ${res.status} while ${context} (${url}). The repo, ref, or path may not exist — ` +
        (hasToken
          ? "or the token lacks access to it."
          : "or the repo is private. Set GITHUB_TOKEN to access private repos."),
    );
  }
  return new Error(`GitHub returned ${res.status} while ${context} (${url}).`);
}

/**
 * Resolve the default branch for a repo via GitHub's public API.
 * Used when the user omits `@ref`.
 */
async function resolveDefaultBranch(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await fetchImpl(url, {
    headers: githubHeaders({ Accept: "application/vnd.github+json" }),
    // Never follow a redirect with the bearer token attached — a cross-origin
    // 30x would re-send Authorization to the redirect target. (security H3)
    redirect: "error",
  });
  if (!res.ok) {
    throw describeGitHubFailure(res, url, "resolving the default branch");
  }
  const body = (await res.json()) as { default_branch?: string };
  if (!body.default_branch) {
    throw new Error(`GitHub API returned no default_branch for ${owner}/${repo}.`);
  }
  return body.default_branch;
}

/** Match a 40-character lowercase hex commit SHA. */
const SHA40_RE = /^[a-f0-9]{40}$/i;

/**
 * Resolve any git ref to its tip-of-fetch-time commit SHA. A 40-hex SHA
 * round-trips unchanged. Branches and tags are resolved via GitHub's
 * `/repos/{o}/{r}/commits/{ref}` endpoint, which returns the current
 * commit hash for that ref. Used to pin the fetch so that a force-push
 * between manifest fetch and per-atom fetches cannot swap content under
 * us. From security-reviewer HIGH-6 (iter-5).
 */
async function resolveRefToSha(
  owner: string,
  repo: string,
  ref: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  if (SHA40_RE.test(ref)) return ref.toLowerCase();
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
  const res = await fetchImpl(url, {
    headers: githubHeaders({ Accept: "application/vnd.github+json" }),
    // Never follow a redirect with the bearer token attached — a cross-origin
    // 30x would re-send Authorization to the redirect target. (security H3)
    redirect: "error",
  });
  if (!res.ok) {
    throw describeGitHubFailure(res, url, `pinning ref "${ref}" to a commit SHA`);
  }
  const body = (await res.json()) as { sha?: string };
  if (!body.sha || !SHA40_RE.test(body.sha)) {
    throw new Error(`GitHub API returned no SHA for ${owner}/${repo}@${ref}.`);
  }
  return body.sha.toLowerCase();
}

/**
 * List every blob path in the repo tree at the pinned SHA. One API call,
 * recursive. Throws when GitHub reports the listing was truncated (packs
 * that large should be cloned, not raw-fetched).
 */
async function listTree(
  owner: string,
  repo: string,
  sha: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(sha)}?recursive=1`;
  const res = await fetchImpl(url, {
    headers: githubHeaders({ Accept: "application/vnd.github+json" }),
    // Never follow a redirect with the bearer token attached — a cross-origin
    // 30x would re-send Authorization to the redirect target. (security H3)
    redirect: "error",
  });
  if (!res.ok) {
    throw describeGitHubFailure(res, url, "listing the repository tree");
  }
  const body = (await res.json()) as {
    tree?: Array<{ path?: string; type?: string }>;
    truncated?: boolean;
  };
  if (body.truncated) {
    throw new Error(
      `GitHub truncated the tree listing for ${owner}/${repo}@${sha} — the repo is too large to fetch file-by-file. Clone it locally and install from the path instead.`,
    );
  }
  return (body.tree ?? [])
    .filter((e) => e.type === "blob" && typeof e.path === "string")
    .map((e) => e.path as string);
}

/**
 * Build the raw.githubusercontent.com URL for a file at a given ref +
 * optional subpath.
 */
function rawUrl(owner: string, repo: string, ref: string, filePath: string): string {
  const cleanPath = filePath.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${cleanPath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/**
 * Hard cap on files materialized from a git source. AgentPacks are small
 * (tens of files); hitting this means the source points at something that
 * is not a pack directory.
 */
const MAX_PACK_FILES = 512;

export interface FetchGitPackOptions {
  source: GitSource;
  /** Where to materialize the tmpRoot. Defaults to a unique dir under os.tmpdir(). */
  tmpRootHint?: string;
  fetchImpl?: typeof fetch;
}

export interface FetchGitPackResult {
  /** Path to the materialized tmpRoot, ready for planInstall. */
  tmpRoot: string;
  /**
   * The 40-character commit SHA all files were actually fetched from. Pinned
   * once up front so a force-push between manifest + atom fetches cannot
   * swap content under us. Record this in the lockfile for reproducibility.
   */
  resolvedSha: string;
  /** The ref the user typed (`null` if `@ref` was omitted). */
  requestedRef: string | null;
}

/**
 * Materialize a git-sourced pack into a tmpRoot suitable for `planInstall`.
 *
 * Steps:
 *   1. If source.ref is null, resolve the repo's default branch.
 *   2. Resolve the ref to a 40-char commit SHA — pin EVERY subsequent fetch
 *      to that SHA so a concurrent force-push cannot rewrite content under
 *      us between the tree listing and the per-file fetches.
 *   3. List the repo tree at the SHA and select every file under the pack
 *      subpath. Require AGENTPACK.yaml among them.
 *   4. Fetch each file at the pinned SHA and write it under tmpRoot.
 *   5. Return { tmpRoot, resolvedSha, requestedRef }.
 */
export async function fetchGitPack(
  options: FetchGitPackOptions,
): Promise<FetchGitPackResult> {
  const { source } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const requestedRef = source.ref;
  const userRefOrDefault =
    source.ref ?? (await resolveDefaultBranch(source.owner, source.repo, fetchImpl));
  // Pin every subsequent fetch to a SHA. Branches and tags resolve through
  // GitHub's commits endpoint; 40-hex SHAs pass through unchanged.
  const ref = await resolveRefToSha(source.owner, source.repo, userRefOrDefault, fetchImpl);

  const subpathPrefix = source.subpath
    ? `${source.subpath.replace(/^\/+|\/+$/g, "")}/`
    : "";

  // 1. Enumerate the pack's files from the tree at the pinned SHA.
  const allPaths = await listTree(source.owner, source.repo, ref, fetchImpl);
  const packPaths = allPaths.filter(
    (p) => subpathPrefix === "" || p.startsWith(subpathPrefix),
  );
  const manifestRepoPath = `${subpathPrefix}AGENTPACK.yaml`;
  if (!packPaths.includes(manifestRepoPath)) {
    throw new Error(
      `No AGENTPACK.yaml at ${source.owner}/${source.repo}@${requestedRef ?? "default"}${source.subpath ? `#${source.subpath}` : ""} — confirm the ref + subpath point at a pack directory.`,
    );
  }
  if (packPaths.length > MAX_PACK_FILES) {
    throw new Error(
      `Pack source lists ${packPaths.length} files (limit ${MAX_PACK_FILES}). Point #subpath at the pack directory rather than a whole repository.`,
    );
  }

  // 2. Materialize tmpRoot.
  const tmpRoot =
    options.tmpRootHint ??
    (await fs.mkdtemp(
      path.join(os.tmpdir(), `agentpack-git-${source.owner}-${source.repo}-`),
    ));
  await fs.mkdir(tmpRoot, { recursive: true });

  // 3. Fetch every pack file at the pinned SHA.
  for (const repoPath of packPaths) {
    const rel = subpathPrefix === "" ? repoPath : repoPath.slice(subpathPrefix.length);
    // Defense-in-depth: the tree API returns repo-relative paths, but never
    // trust them blindly when joining onto the local filesystem.
    if (rel.split("/").includes("..") || rel.startsWith("/")) {
      throw new Error(
        `Tree listing produced suspicious path "${repoPath}" — refusing to write it.`,
      );
    }
    const fileUrl = rawUrl(source.owner, source.repo, ref, repoPath);
    const fileRes = await fetchImpl(fileUrl, {
      headers: githubHeaders(),
      // No credential-leaking redirect follow (security H3).
      redirect: "error",
    });
    if (!fileRes.ok) {
      throw describeGitHubFailure(fileRes, fileUrl, `fetching "${repoPath}"`);
    }
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    const dest = path.join(tmpRoot, rel);
    const destRel = path.relative(tmpRoot, dest);
    if (destRel.startsWith("..") || path.isAbsolute(destRel)) {
      throw new Error(
        `Tree listing produced suspicious path "${repoPath}" — refusing to write it.`,
      );
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, bytes);
  }

  return { tmpRoot, resolvedSha: ref, requestedRef };
}
