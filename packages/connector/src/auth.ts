import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";

/**
 * Minimum length for AGENTPACK_CONNECTOR_TOKEN. 32 chars from a random hex
 * source (`openssl rand -hex 32` emits 64) is the production floor (#63) —
 * the previous 16-char floor allowed tokens weak enough for an
 * internet-reachable bearer secret. Raising it is an intentional breaking
 * change: deployments with shorter tokens must rotate before upgrading.
 */
export const TOKEN_MIN_LENGTH = 32;

/**
 * Environment variable that carries the bearer token required for every
 * request to the MCP endpoint. Must be set and at least TOKEN_MIN_LENGTH
 * characters; the server refuses to start otherwise.
 */
export const TOKEN_ENV_VAR = "AGENTPACK_CONNECTOR_TOKEN";

/**
 * Constant-time string comparison that guards against timing side-channels.
 * Returns false (rather than throwing) if either value is empty — avoids
 * length-leak when the incoming token is zero-length.
 */
export function timingSafeEqual_str(a: string, b: string): boolean {
  // Compare BYTES, not UTF-16 code units. `Buffer.alloc(a.length)` sizes by
  // code units while `.write()` truncates at the byte boundary, so a multibyte
  // token (e.g. a passphrase with a non-ASCII tail) could collide with a
  // different equal-code-unit string. Encode to UTF-8 buffers up front and
  // gate on byte length. (security-reviewer MEDIUM-1, iter-9.)
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length === 0 || bBuf.length === 0) return false;
  // Pad to equal byte length so timingSafeEqual does not throw; the final
  // byte-length equality check is what actually decides a length mismatch.
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len, 0);
  const bPad = Buffer.alloc(len, 0);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  return timingSafeEqual(aPad, bPad) && aBuf.length === bBuf.length;
}

/**
 * Validate token from env at startup. Call once before binding the listener.
 * Throws with a human-readable message if the token is absent or too short.
 */
export function validateTokenEnv(): string {
  const token = process.env[TOKEN_ENV_VAR];
  if (!token) {
    throw new Error(
      `[agentpack-connector] ${TOKEN_ENV_VAR} is not set. ` +
        `Set it to a random secret of at least ${TOKEN_MIN_LENGTH} characters before starting the server. ` +
        `Example: export ${TOKEN_ENV_VAR}=$(openssl rand -hex 32)`,
    );
  }
  if (token.length < TOKEN_MIN_LENGTH) {
    throw new Error(
      `[agentpack-connector] ${TOKEN_ENV_VAR} is too short (${token.length} chars, minimum ${TOKEN_MIN_LENGTH}). ` +
        `Use a secret of at least ${TOKEN_MIN_LENGTH} characters. Example: export ${TOKEN_ENV_VAR}=$(openssl rand -hex 32)`,
    );
  }
  return token;
}

/**
 * Hono middleware that enforces bearer-token auth on every request it is
 * applied to. Responds 401 with a WWW-Authenticate header on any failure.
 * Fails closed — if the comparison throws, the request is rejected.
 *
 * @param expectedToken  The validated server secret (from validateTokenEnv).
 */
export function bearerAuthMiddleware(expectedToken: string): MiddlewareHandler {
  return async (c: Context, next) => {
    try {
      const authHeader = c.req.header("authorization") ?? "";
      const prefix = "Bearer ";
      if (!authHeader.startsWith(prefix)) {
        return unauthorized(c);
      }
      const incoming = authHeader.slice(prefix.length);
      if (!timingSafeEqual_str(incoming, expectedToken)) {
        return unauthorized(c);
      }
    } catch {
      // Fail closed — any exception in the auth check rejects the request.
      return unauthorized(c);
    }
    await next();
  };
}

function unauthorized(c: Context): Response {
  return c.json({ error: "Unauthorized" }, 401, {
    "WWW-Authenticate": 'Bearer realm="agentpack-connector"',
  });
}

/**
 * Hostname allowlist for DNS-rebinding protection.
 * Covers the default localhost bindings and any extra hosts the operator
 * configures via AGENTPACK_CONNECTOR_ALLOWED_HOSTS (comma-separated).
 */
export const DEFAULT_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * Build the effective host allowlist. Operator may extend via env var;
 * defaults always include localhost and the IPv4/IPv6 loopback.
 */
export function buildAllowedHosts(): Set<string> {
  const extra = (process.env["AGENTPACK_CONNECTOR_ALLOWED_HOSTS"] ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_HOSTS, ...extra]);
}

/**
 * Hono middleware that rejects requests whose Host header is not in the
 * allowlist. When an Origin header is present it must also be allowed
 * (scheme+host must match an allowed host after stripping the scheme).
 *
 * This guards against DNS-rebinding attacks where a malicious page
 * resolves an attacker-controlled hostname to 127.0.0.1 and POSTs to
 * the local connector.
 *
 * The MCP SDK's built-in enableDnsRebindingProtection / allowedHosts /
 * allowedOrigins options are available but marked @deprecated in SDK
 * 1.29.0 in favour of external middleware — we use external middleware.
 *
 * @param allowedHosts  Set of permitted Host values (hostname[:port] form).
 */
export function dnsRebindingMiddleware(allowedHosts: Set<string>): MiddlewareHandler {
  return async (c: Context, next) => {
    const host = c.req.header("host") ?? "";
    // Strip the port for the allowlist check, bracket-aware so a bracketed
    // IPv6 host with a port (`[::1]:8787`) reduces to `[::1]` rather than `[`.
    // (security-reviewer LOW-1, iter-9.)
    const hostNoPort = host.startsWith("[")
      ? host.slice(0, host.indexOf("]") + 1)
      : (host.split(":")[0] ?? "");

    if (!allowedHosts.has(host) && !allowedHosts.has(hostNoPort)) {
      return c.json({ error: "Forbidden: disallowed Host header" }, 403);
    }

    const origin = c.req.header("origin");
    if (origin) {
      // Extract the hostname from the Origin URL.
      let originHost: string;
      try {
        originHost = new URL(origin).hostname;
      } catch {
        return c.json({ error: "Forbidden: malformed Origin header" }, 403);
      }
      if (!allowedHosts.has(originHost)) {
        return c.json({ error: "Forbidden: disallowed Origin header" }, 403);
      }
    }

    await next();
  };
}
