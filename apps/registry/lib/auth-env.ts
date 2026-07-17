/**
 * Startup validation for the registry's auth environment (#63 B2 + S1).
 *
 * Auth-at-the-boundary: when DATABASE_URL is set the registry is active, and
 * an empty GITHUB_ID/GITHUB_SECRET or a missing/short AUTH_SECRET must fail
 * loudly at startup — initializing a GitHub provider with `"" `-fallback
 * credentials produces a registry where sign-in can never succeed, which is
 * strictly worse than refusing to boot. When DATABASE_URL is unset, the
 * no-DB dev path (seed-pack browsing, 503 auth stubs) stays fully
 * unconfigured — mirrors `getDb()`'s graceful cascade (ISC-223).
 *
 * Mirrors the connector's `validateTokenEnv()` pattern
 * (packages/connector/src/auth.ts): validate once at startup, throw with a
 * human-readable message, return the validated values.
 */

/** Minimum AUTH_SECRET length — matches the connector token floor. */
export const AUTH_SECRET_MIN_LENGTH = 32;

export interface RegistryAuthEnv {
  githubId: string;
  githubSecret: string;
  authSecret: string;
}

/**
 * Validate the registry auth env. Returns `null` when DATABASE_URL is unset
 * (auth is stubbed to 503s in that mode); otherwise returns the validated
 * values or throws listing EVERY missing/invalid variable, so an operator
 * fixes the env in one pass instead of replaying boot failures.
 */
export function validateRegistryAuthEnv(
  env: Record<string, string | undefined> = process.env,
): RegistryAuthEnv | null {
  if (!env["DATABASE_URL"]) return null;

  const githubId = (env["GITHUB_ID"] ?? "").trim();
  const githubSecret = (env["GITHUB_SECRET"] ?? "").trim();
  const authSecret = env["AUTH_SECRET"] ?? "";

  const problems: string[] = [];
  if (!githubId) {
    problems.push(
      "GITHUB_ID is not set (or empty). Set it to the GitHub OAuth app's client id.",
    );
  }
  if (!githubSecret) {
    problems.push(
      "GITHUB_SECRET is not set (or empty). Set it to the GitHub OAuth app's client secret.",
    );
  }
  if (authSecret.length < AUTH_SECRET_MIN_LENGTH) {
    problems.push(
      `AUTH_SECRET is ${authSecret.length === 0 ? "not set" : `too short (${authSecret.length} chars)`} — ` +
        `minimum ${AUTH_SECRET_MIN_LENGTH} chars. Generate one: openssl rand -hex 32`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      "[registry/auth] DATABASE_URL is set but the auth environment is incomplete — refusing to start:\n" +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }

  return { githubId, githubSecret, authSecret };
}
