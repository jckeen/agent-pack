import { redirect } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";

import { TOKEN_SCOPES } from "@agentpack/core";

import { auth, signIn } from "@/lib/auth";
import { apiTokens, getDb } from "@/lib/db";
import { generateToken } from "@/lib/tokens";

interface PageProps {
  searchParams: Promise<{ created?: string; prefix?: string }>;
}

async function createTokenAction(formData: FormData): Promise<void> {
  "use server";
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/tokens?error=unauthorized");
  }
  const db = getDb();
  if (!db) {
    redirect("/tokens?error=db_unconfigured");
  }
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    redirect("/tokens?error=name_required");
  }
  const scopes = formData
    .getAll("scopes")
    .map((s) => String(s))
    .filter((s) => (TOKEN_SCOPES as readonly string[]).includes(s));
  if (scopes.length === 0) {
    redirect("/tokens?error=scopes_required");
  }
  const { token, prefix, sha256 } = generateToken();
  await db.insert(apiTokens).values({
    userId: session.user.id,
    publisherId: null,
    name,
    tokenPrefix: prefix,
    tokenSha256: sha256,
    scopes,
  });
  // Plaintext token included in redirect URL — acceptable for MVP since this
  // is the user's own session and they're instructed to copy immediately.
  // The token has 128 bits of entropy and is shown ONCE; refreshing the page
  // drops it.
  redirect(
    `/tokens?created=${encodeURIComponent(token)}&prefix=${encodeURIComponent(prefix)}`
  );
}

async function revokeTokenAction(formData: FormData): Promise<void> {
  "use server";
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/tokens?error=unauthorized");
  }
  const db = getDb();
  if (!db) {
    redirect("/tokens?error=db_unconfigured");
  }
  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    redirect("/tokens?error=id_required");
  }
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, session.user.id)));
  redirect("/tokens?revoked=1");
}

async function signInAction(): Promise<void> {
  "use server";
  await signIn("github");
}

export default async function TokensPage({
  searchParams,
}: PageProps) {
  const session = await auth();
  const params = await searchParams;
  const justCreatedToken = params.created;
  const justCreatedPrefix = params.prefix;

  if (!session?.user?.id) {
    return (
      <div className="container-page space-y-6">
        <h1 className="h1">API tokens</h1>
        <p className="text-ink-600">
          Sign in to mint and revoke tokens for publishing AgentPacks.
        </p>
        <form action={signInAction}>
          <button
            type="submit"
            className="rounded-md bg-ink-900 px-4 py-2 text-sm font-semibold text-white shadow-soft hover:bg-ink-800"
          >
            Sign in with GitHub
          </button>
        </form>
      </div>
    );
  }

  const db = getDb();
  let tokens: Array<{
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    last_used_at: Date | null;
    created_at: Date | null;
  }> = [];
  let dbError: string | null = null;
  if (!db) {
    dbError = "Registry DB is not configured on this deployment.";
  } else {
    try {
      const rows = await db
        .select({
          id: apiTokens.id,
          name: apiTokens.name,
          prefix: apiTokens.tokenPrefix,
          scopes: apiTokens.scopes,
          last_used_at: apiTokens.lastUsedAt,
          created_at: apiTokens.createdAt,
        })
        .from(apiTokens)
        .where(
          and(
            eq(apiTokens.userId, session.user.id),
            isNull(apiTokens.revokedAt)
          )
        )
        .orderBy(desc(apiTokens.createdAt));
      tokens = rows;
    } catch (err) {
      console.error("[tokens-page] list failed:", err);
      dbError = "Failed to load tokens.";
    }
  }

  return (
    <div className="container-page space-y-8">
      <header className="space-y-2">
        <h1 className="h1">API tokens</h1>
        <p className="text-ink-600">
          Signed in as <span className="font-medium">{session.user.email}</span>
          {session.publisherSlugs && session.publisherSlugs.length > 0 ? (
            <>
              {" "}
              · publishers:{" "}
              {session.publisherSlugs.map((slug) => (
                <span key={slug} className="pill mr-1">
                  {slug}
                </span>
              ))}
            </>
          ) : null}
        </p>
      </header>

      {justCreatedToken ? (
        <div className="card border-accent-200 bg-accent-50">
          <h2 className="h2 text-accent-700">New token created</h2>
          <p className="mt-2 text-sm text-ink-700">
            Copy this token now. It will not be shown again. Prefix in your
            token list is{" "}
            <code className="font-mono text-xs">{justCreatedPrefix}</code>.
          </p>
          <pre className="codeblock mt-3 select-all break-all">
            {justCreatedToken}
          </pre>
        </div>
      ) : null}

      {dbError ? (
        <div className="card border-red-200 bg-red-50 text-sm text-red-700">
          {dbError}
        </div>
      ) : null}

      <section className="card">
        <h2 className="h2">Create a token</h2>
        <form action={createTokenAction} className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-ink-700"
            >
              Name
            </label>
            <input
              id="name"
              name="name"
              required
              maxLength={120}
              placeholder="e.g. local-dev or CI publish"
              className="mt-1 block w-full rounded-md border border-ink-200 px-3 py-2 text-sm shadow-sm focus:border-ink-400 focus:outline-none"
            />
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-ink-700">Scopes</legend>
            <div className="mt-2 flex flex-wrap gap-3">
              {TOKEN_SCOPES.map((scope) => (
                <label
                  key={scope}
                  className="flex items-center gap-2 text-sm text-ink-700"
                >
                  <input
                    type="checkbox"
                    name="scopes"
                    value={scope}
                    defaultChecked={scope === "read:packs"}
                    className="h-4 w-4 rounded border-ink-300"
                  />
                  <code className="font-mono text-xs">{scope}</code>
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="submit"
            className="rounded-md bg-ink-900 px-4 py-2 text-sm font-semibold text-white shadow-soft hover:bg-ink-800"
          >
            Create token
          </button>
        </form>
      </section>

      <section className="card">
        <h2 className="h2">Active tokens</h2>
        {tokens.length === 0 ? (
          <p className="mt-3 text-sm text-ink-500">
            No active tokens. Create one above to get started.
          </p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-ink-400">
                <th className="py-2">Name</th>
                <th className="py-2">Prefix</th>
                <th className="py-2">Scopes</th>
                <th className="py-2">Last used</th>
                <th className="py-2">Created</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td className="py-2 font-medium text-ink-900">{t.name}</td>
                  <td className="py-2">
                    <code className="font-mono text-xs text-ink-600">
                      {t.prefix}…
                    </code>
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {t.scopes.map((scope) => (
                        <span key={scope} className="pill">
                          {scope}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 text-ink-500">
                    {t.last_used_at
                      ? new Date(t.last_used_at).toISOString().slice(0, 10)
                      : "never"}
                  </td>
                  <td className="py-2 text-ink-500">
                    {t.created_at
                      ? new Date(t.created_at).toISOString().slice(0, 10)
                      : "—"}
                  </td>
                  <td className="py-2">
                    <form action={revokeTokenAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <button
                        type="submit"
                        className="text-xs font-medium text-red-600 hover:text-red-700"
                      >
                        Revoke
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
