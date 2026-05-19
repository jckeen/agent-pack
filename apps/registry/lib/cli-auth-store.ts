/**
 * In-memory device-code store for `workgraph login`. Phase 3 uses a Map keyed
 * by device code with a 15-minute TTL. Phase 6 will swap this for a Redis-
 * backed store so multi-instance deployments share state.
 */

import { randomBytes } from "node:crypto";

const TTL_MS = 15 * 60 * 1000;

interface DeviceCodeEntry {
  deviceCode: string;
  userCode: string;
  expiresAt: number;
  approvedTokenForUser?: { token: string; userId: string; username: string; publisherSlugs: string[] };
}

const byDeviceCode = new Map<string, DeviceCodeEntry>();
const byUserCode = new Map<string, string>(); // userCode → deviceCode

function gc(): void {
  const now = Date.now();
  for (const [code, entry] of byDeviceCode) {
    if (entry.expiresAt < now) {
      byDeviceCode.delete(code);
      byUserCode.delete(entry.userCode);
    }
  }
}

export function createDeviceCode(): DeviceCodeEntry {
  gc();
  const deviceCode = randomBytes(16).toString("hex");
  const userCode = randomBytes(4).toString("hex").toUpperCase();
  const entry: DeviceCodeEntry = {
    deviceCode,
    userCode,
    expiresAt: Date.now() + TTL_MS,
  };
  byDeviceCode.set(deviceCode, entry);
  byUserCode.set(userCode, deviceCode);
  return entry;
}

export function approveUserCode(
  userCode: string,
  token: string,
  user: { userId: string; username: string; publisherSlugs: string[] }
): DeviceCodeEntry | null {
  gc();
  const deviceCode = byUserCode.get(userCode);
  if (!deviceCode) return null;
  const entry = byDeviceCode.get(deviceCode);
  if (!entry) return null;
  entry.approvedTokenForUser = {
    token,
    userId: user.userId,
    username: user.username,
    publisherSlugs: user.publisherSlugs,
  };
  return entry;
}

export function pollDeviceCode(deviceCode: string):
  | { status: "pending" }
  | {
      status: "complete";
      token: string;
      user: { id: string; username: string; publisherSlugs: string[] };
    }
  | { status: "expired" } {
  gc();
  const entry = byDeviceCode.get(deviceCode);
  if (!entry) return { status: "expired" };
  if (entry.expiresAt < Date.now()) {
    byDeviceCode.delete(deviceCode);
    byUserCode.delete(entry.userCode);
    return { status: "expired" };
  }
  if (!entry.approvedTokenForUser) {
    return { status: "pending" };
  }
  // One-shot: consume the approval.
  byDeviceCode.delete(deviceCode);
  byUserCode.delete(entry.userCode);
  return {
    status: "complete",
    token: entry.approvedTokenForUser.token,
    user: {
      id: entry.approvedTokenForUser.userId,
      username: entry.approvedTokenForUser.username,
      publisherSlugs: entry.approvedTokenForUser.publisherSlugs,
    },
  };
}
