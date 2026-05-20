/**
 * Credentials file for the CLI — `~/.agentpack/credentials.json`.
 *
 * Honors `WORKGRAPH_HOME` env override for tests. Mode `0o600` on POSIX (no-op
 * on Windows). Atomic write via temp file + rename. Token storage is plain —
 * if a user wants stronger storage they can wrap the CLI with a keychain
 * front-end; protocol-level we follow the npm/pnpm convention.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface CredentialsEntry {
  token: string;
  scopes: string[];
  username: string;
}

export interface CredentialsFile {
  registries: Record<string, CredentialsEntry>;
}

const WORKGRAPH_HOME = (): string =>
  process.env.WORKGRAPH_HOME ?? path.join(os.homedir(), ".agentpack");

export function credentialsPath(): string {
  return path.join(WORKGRAPH_HOME(), "credentials.json");
}

export async function readCredentials(): Promise<CredentialsFile> {
  const file = credentialsPath();
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as CredentialsFile;
    if (!parsed.registries || typeof parsed.registries !== "object") {
      return { registries: {} };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { registries: {} };
    }
    throw err;
  }
}

export async function writeCredentials(
  registryUrl: string,
  entry: CredentialsEntry
): Promise<void> {
  const current = await readCredentials();
  current.registries[registryUrl] = entry;
  await persist(current);
}

export async function clearCredentials(registryUrl: string): Promise<void> {
  const current = await readCredentials();
  delete current.registries[registryUrl];
  await persist(current);
}

export async function getToken(
  registryUrl: string
): Promise<string | null> {
  const envToken = process.env.AGENTPACK_TOKEN;
  if (envToken) return envToken;
  const creds = await readCredentials();
  return creds.registries[registryUrl]?.token ?? null;
}

async function persist(creds: CredentialsFile): Promise<void> {
  const dir = WORKGRAPH_HOME();
  await fs.mkdir(dir, { recursive: true });
  const file = credentialsPath();
  const tmpName = `credentials.${randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  await fs.writeFile(tmpPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, file);
  if (process.platform !== "win32") {
    try {
      await fs.chmod(file, 0o600);
    } catch {
      /* ignore on filesystems that don't support mode */
    }
  }
}

export function maskToken(token: string): string {
  if (token.length <= 12) return token;
  const last = token.slice(-4);
  return `${token.slice(0, 12)}…${last}`;
}
