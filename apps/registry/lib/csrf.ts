/**
 * Origin/Sec-Fetch-Site CSRF guard for session-cookie-authenticated writes.
 *
 * NextAuth v5 only protects its own `/api/auth/*` endpoints, not arbitrary app
 * routes. An attacker page can auto-submit a request with the user's session
 * cookie attached, so every route that authenticates with `auth()` and changes
 * state calls this before doing anything else. From security-reviewer HIGH-3
 * (iter-5); applied to every such route in #268.
 *
 * `req.json()` parses the body whatever its declared type, and a cross-origin
 * HTML form can send `text/plain` — so a route that reads a JSON body must
 * also require a content type the simple-request CORS rules cannot construct.
 */

import { NextResponse } from "next/server";

export interface CsrfViolation {
  status: 403 | 415;
  error: "csrf_content_type" | "csrf_origin";
  message: string;
}

export interface CsrfGuardOptions {
  /**
   * Require `Content-Type: application/json`. Default true; pass false only
   * for a route that reads no body (e.g. DELETE), where the method itself
   * already forces a CORS preflight.
   */
  requireJson?: boolean;
}

/** Pure check — returns the violation, or null when the request may proceed. */
export function csrfViolation(
  req: Request,
  options: CsrfGuardOptions = {},
): CsrfViolation | null {
  if (options.requireJson ?? true) {
    const contentType = req.headers.get("content-type") ?? "";
    if (!/^application\/json(\s*;|$)/i.test(contentType)) {
      return {
        status: 415,
        error: "csrf_content_type",
        message: "Content-Type must be application/json",
      };
    }
  }
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return { status: 403, error: "csrf_origin", message: "Cross-origin write rejected" };
  }
  const origin = req.headers.get("origin");
  const expected = process.env.NEXT_PUBLIC_REGISTRY_URL?.replace(/\/$/, "");
  if (origin && expected && origin !== expected) {
    return {
      status: 403,
      error: "csrf_origin",
      message: "Origin does not match deployed registry",
    };
  }
  return null;
}

/** Route-facing wrapper: a ready error response, or null to proceed. */
export function csrfGuard(req: Request, options: CsrfGuardOptions = {}): Response | null {
  const violation = csrfViolation(req, options);
  if (!violation) return null;
  return NextResponse.json(
    { error: violation.error, message: violation.message },
    { status: violation.status },
  );
}
