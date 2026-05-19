import { NextResponse } from "next/server";

import { pollDeviceCode } from "@/lib/cli-auth-store";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as
    | { deviceCode?: string }
    | null;
  if (!body?.deviceCode) {
    return NextResponse.json({ error: "missing_device_code" }, { status: 400 });
  }
  const result = pollDeviceCode(body.deviceCode);
  return NextResponse.json(result);
}
