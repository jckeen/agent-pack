import { NextResponse } from "next/server";

import { createDeviceCode } from "@/lib/cli-auth-store";
import { clientKey, hit, tooManyRequests } from "@/lib/rate-limit";

export async function POST(req: Request): Promise<Response> {
  // Cap device-code minting per IP so the in-memory store can't be flooded.
  const rl = hit(clientKey(req, "auth-init"), 20, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);
  const entry = createDeviceCode();
  return NextResponse.json({
    deviceCode: entry.deviceCode,
    userCode: entry.userCode,
    verificationUrl: `${process.env.NEXT_PUBLIC_REGISTRY_URL ?? ""}/cli/auth`,
    expiresAt: new Date(entry.expiresAt).toISOString(),
    interval: 5,
  });
}
