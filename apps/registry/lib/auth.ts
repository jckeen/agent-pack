import NextAuth, { type NextAuthConfig, type Session } from "next-auth";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";

import {
  getDb,
  users,
  accounts,
  sessions,
  verificationTokens,
  publisherMembers,
  publishers,
} from "./db";

/**
 * NextAuth v5 (beta-31) configuration. GitHub OAuth is the only provider in
 * Phase 3. Drizzle adapter v1.11.2 wires session/user persistence onto the
 * registry's Postgres instance.
 *
 * When DATABASE_URL is unset, we cannot construct an adapter — so all
 * NextAuth surfaces fall back to a 503 stub. This matches the protocol's
 * "graceful cascade" contract (Plans/PROTOCOL.md § 8).
 */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
    publisherSlugs: string[];
  }
}

interface AuthSurface {
  handlers: {
    GET: (req: Request) => Response | Promise<Response>;
    POST: (req: Request) => Response | Promise<Response>;
  };
  auth: () => Promise<Session | null>;
  signIn: (...args: unknown[]) => Promise<unknown>;
  signOut: (...args: unknown[]) => Promise<unknown>;
}

function buildAuth(): AuthSurface {
  const db = getDb();
  if (!db) {
    const stub503 = (): Response =>
      new Response(JSON.stringify({ error: "auth_unconfigured" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    return {
      handlers: { GET: stub503, POST: stub503 },
      auth: async () => null,
      signIn: async () => {
        throw new Error("auth_unconfigured");
      },
      signOut: async () => {
        throw new Error("auth_unconfigured");
      },
    };
  }

  const config: NextAuthConfig = {
    // NextAuth beta-31 + Drizzle adapter 1.11.2 intentionally accept a
    // permissive table-shape on the adapter argument — adapter typing across
    // both packages hasn't stabilized to a single `AdapterAccount` literal.
    // Runtime behavior is what's load-bearing here.
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any),
    providers: [
      GitHub({
        clientId: process.env["GITHUB_ID"] ?? "",
        clientSecret: process.env["GITHUB_SECRET"] ?? "",
      }),
    ],
    secret: process.env["AUTH_SECRET"],
    session: { strategy: "database" },
    callbacks: {
      async session({ session, user }) {
        if (!session.user) return session;
        const enriched = session as Session;
        enriched.user.id = user.id;
        try {
          const rows = await db
            .select({ slug: publishers.slug })
            .from(publisherMembers)
            .innerJoin(
              publishers,
              eq(publisherMembers.publisherId, publishers.id)
            )
            .where(eq(publisherMembers.userId, user.id));
          enriched.publisherSlugs = rows.map((r) => r.slug);
        } catch (err) {
          console.error("[auth] session enrichment failed:", err);
          enriched.publisherSlugs = [];
        }
        return enriched;
      },
    },
  };

  const surface = NextAuth(config);
  return surface as unknown as AuthSurface;
}

const _auth = buildAuth();

export const handlers = _auth.handlers;
export const auth = _auth.auth;
export const signIn = _auth.signIn;
export const signOut = _auth.signOut;
