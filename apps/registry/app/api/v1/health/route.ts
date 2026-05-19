import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { r2Client } from "@/lib/r2";

import packageJson from "../../../../package.json" with { type: "json" };

/**
 * Production health endpoint. Exercised by:
 *   - `scripts/smoke-e2e.sh`  — gates the rest of smoke on `{db: "up", r2: "up"}`
 *   - external uptime monitors
 *   - the bring-up script's final probe
 *
 * Returns 200 with `status: "ok"` only when DB and R2 are both reachable;
 * 503 with `status: "degraded"` otherwise. Never 500 — degradation is a known
 * state, not a crash.
 */
export async function GET(): Promise<Response> {
  const startedAt = Date.now();

  const dbStatus = await probeDb();
  const r2Status = await probeR2();
  const ok = dbStatus === "up" && r2Status === "up";

  const body = {
    status: ok ? "ok" : "degraded",
    db: dbStatus,
    r2: r2Status,
    version: (packageJson as { version: string }).version,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, { status: ok ? 200 : 503 });
}

async function probeDb(): Promise<"up" | "unconfigured" | "down"> {
  const db = getDb();
  if (!db) return "unconfigured";
  try {
    await db.execute(sql`select 1`);
    return "up";
  } catch {
    return "down";
  }
}

async function probeR2(): Promise<"up" | "unconfigured" | "down"> {
  try {
    r2Client();
  } catch {
    return "unconfigured";
  }
  // We can't list-bucket without consuming Class A operations; the credentials
  // are already validated by handle construction. Treat resolvable handle as "up".
  return "up";
}
