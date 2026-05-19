import { NextResponse } from "next/server";

import { createDeviceCode } from "@/lib/cli-auth-store";

export async function POST(): Promise<Response> {
  const entry = createDeviceCode();
  return NextResponse.json({
    deviceCode: entry.deviceCode,
    userCode: entry.userCode,
    verificationUrl: `${process.env.NEXT_PUBLIC_REGISTRY_URL ?? ""}/cli/auth`,
    expiresAt: new Date(entry.expiresAt).toISOString(),
    interval: 5,
  });
}
