/**
 * Route-handler tests for the CLI device-auth flow (Issue #25):
 *
 *   POST /api/cli/auth/init     — mint a device+user code (rate-limited)
 *   POST /api/cli/auth/poll     — exchange a device code for a token once approved
 *   POST /api/cli/auth/approve  — bind the caller's identity+token to a user code
 *
 * The in-memory `cli-auth-store` and the in-process `rate-limit` map are kept
 * REAL (they're the behavior under test); only the session (`@/lib/auth`), the
 * DB (`@/lib/db`), and token generation boundaries are scripted. The headline
 * regression: a *failed* approve (bad user code) must NOT persist a live token
 * (the route previously minted before validating — backend-architect H2).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const _auth: { session: unknown } = { session: null };

const _db: { configured: boolean; queue: unknown[][]; insertCount: number } = {
  configured: true,
  queue: [],
  insertCount: 0,
};

function makeChain(result: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "innerJoin", "limit", "values", "returning", "set"]) {
    chain[m] = () => chain;
  }
  chain.then = (
    onFulfilled: (v: unknown[]) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

function fakeDb(): Record<string, unknown> {
  const next = (): Record<string, unknown> => makeChain(_db.queue.shift() ?? []);
  return {
    select: () => next(),
    insert: () => {
      _db.insertCount += 1;
      return next();
    },
    update: () => next(),
  };
}

vi.mock("@/lib/auth", () => ({ auth: async () => _auth.session }));

vi.mock("@/lib/db", () => ({
  getDb: () => (_db.configured ? fakeDb() : null),
  apiTokens: {},
  users: { id: "id", username: "username" },
  publishers: { id: "id", slug: "slug" },
  publisherMembers: { userId: "user_id", publisherId: "publisher_id" },
}));

import { POST as authInit } from "@/app/api/cli/auth/init/route";
import { POST as authPoll } from "@/app/api/cli/auth/poll/route";
import { POST as authApprove } from "@/app/api/cli/auth/approve/route";

let ipCounter = 0;
function jsonReq(url: string, body?: unknown, ip?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers["x-forwarded-for"] = ip ?? `10.2.0.${++ipCounter}`;
  return new Request(url, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  _auth.session = null;
  _db.configured = true;
  _db.queue = [];
  _db.insertCount = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/cli/auth/init", () => {
  it("mints a device+user code pair with a verification URL and interval", async () => {
    const res = await authInit(jsonReq("https://x/api/cli/auth/init"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.deviceCode).toBe("string");
    expect(json.deviceCode.length).toBeGreaterThanOrEqual(32); // 128-bit hex
    expect(json.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(json.interval).toBe(5);
    expect(typeof json.expiresAt).toBe("string");
  });

  it("429s once the per-IP init budget (20/min) is exhausted", async () => {
    const ip = "203.0.113.7";
    let last: Response | undefined;
    for (let i = 0; i < 21; i++)
      last = await authInit(jsonReq("https://x/api/cli/auth/init", undefined, ip));
    expect(last?.status).toBe(429);
  });
});

describe("POST /api/cli/auth/poll", () => {
  it("400s without a device code", async () => {
    const res = await authPoll(jsonReq("https://x/api/cli/auth/poll", {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_device_code");
  });

  it("reports expired for an unknown device code", async () => {
    const res = await authPoll(
      jsonReq("https://x/api/cli/auth/poll", { deviceCode: "nope" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("expired");
  });

  it("reports pending for a freshly-minted, not-yet-approved code", async () => {
    const init = await (await authInit(jsonReq("https://x/api/cli/auth/init"))).json();
    const res = await authPoll(
      jsonReq("https://x/api/cli/auth/poll", { deviceCode: init.deviceCode }),
    );
    expect((await res.json()).status).toBe("pending");
  });
});

describe("POST /api/cli/auth/approve", () => {
  it("401s without a session", async () => {
    _auth.session = null;
    const res = await authApprove(
      jsonReq("https://x/api/cli/auth/approve", { userCode: "X" }),
    );
    expect(res.status).toBe(401);
  });

  it("400s without a user code", async () => {
    _auth.session = { user: { id: "u1" } };
    const res = await authApprove(jsonReq("https://x/api/cli/auth/approve", {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_user_code");
  });

  it("REGRESSION: a bad user code 404s and persists NO token (no orphan credential)", async () => {
    _auth.session = { user: { id: "u1", name: "alice" } };
    // user + membership selects run before the bind attempt.
    _db.queue = [[{ username: "alice" }], [{ slug: "acme" }]];
    const res = await authApprove(
      jsonReq("https://x/api/cli/auth/approve", { userCode: "DEAD-BEEF-DEAD-BEEF" }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("invalid_user_code");
    // The fix: the token is only inserted AFTER the user code validates.
    expect(_db.insertCount).toBe(0);
  });

  it("binds the token on a valid user code so poll then returns it (full flow)", async () => {
    // 1. CLI starts a device flow.
    const init = await (await authInit(jsonReq("https://x/api/cli/auth/init"))).json();
    // 2. Logged-in user approves the user code shown on the device.
    _auth.session = { user: { id: "u1", name: "alice" } };
    _db.queue = [[{ username: "alice" }], [{ slug: "acme" }]];
    const approve = await authApprove(
      jsonReq("https://x/api/cli/auth/approve", { userCode: init.userCode }),
    );
    expect(approve.status).toBe(204);
    expect(_db.insertCount).toBe(1); // token persisted exactly once, after the bind
    // 3. The CLI polls and receives the bound token + identity.
    const poll = await (
      await authPoll(
        jsonReq("https://x/api/cli/auth/poll", { deviceCode: init.deviceCode }),
      )
    ).json();
    expect(poll.status).toBe("complete");
    expect(typeof poll.token).toBe("string");
    expect(poll.user).toMatchObject({
      id: "u1",
      username: "alice",
      publisherSlugs: ["acme"],
    });
    // 4. The approval is one-shot — a second poll is spent/expired.
    const poll2 = await (
      await authPoll(
        jsonReq("https://x/api/cli/auth/poll", { deviceCode: init.deviceCode }),
      )
    ).json();
    expect(poll2.status).toBe("expired");
  });
});
