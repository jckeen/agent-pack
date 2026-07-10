/**
 * `HttpRegistryClient` — production client against the Phase 3 registry API.
 *
 * Every `fetchAtomFile` verifies sha256 against the expected hash; mismatch
 * throws `IntegrityError` (exit 7).
 */

import { createHash } from "node:crypto";

import type { RegistryPack, RegistryVersion } from "../protocol/index.js";

import { IntegrityError, RegistryError, VersionNotFoundError } from "./errors.js";
import type { RegistryClient } from "./types.js";

export interface HttpRegistryClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export class HttpRegistryClient implements RegistryClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpRegistryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async req(url: string, init?: RequestInit): Promise<Response> {
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string>) },
      // Never follow a redirect with the bearer token attached — a
      // cross-origin 30x would re-send Authorization to the redirect target
      // (same invariant as the git-source fetches).
      redirect: "error",
    });
    return res;
  }

  async listVersions(publisher: string, pack: string): Promise<RegistryPack> {
    const url = `${this.baseUrl}/api/packs/${encodeURIComponent(
      publisher,
    )}/${encodeURIComponent(pack)}`;
    const res = await this.req(url);
    if (res.status === 404) {
      throw new VersionNotFoundError(publisher, pack);
    }
    if (!res.ok) {
      throw new RegistryError(
        `listVersions ${publisher}/${pack} → HTTP ${res.status}`,
        res.status,
      );
    }
    return (await res.json()) as RegistryPack;
  }

  async getVersion(
    publisher: string,
    pack: string,
    version: string,
  ): Promise<RegistryVersion> {
    const url = `${this.baseUrl}/api/packs/${encodeURIComponent(
      publisher,
    )}/${encodeURIComponent(pack)}/versions/${encodeURIComponent(version)}`;
    const res = await this.req(url);
    if (res.status === 404) {
      throw new VersionNotFoundError(publisher, pack, version);
    }
    if (!res.ok) {
      throw new RegistryError(
        `getVersion ${publisher}/${pack}@${version} → HTTP ${res.status}`,
        res.status,
      );
    }
    return (await res.json()) as RegistryVersion;
  }

  async fetchManifest(publisher: string, pack: string, version: string): Promise<string> {
    const url = `${this.baseUrl}/api/packs/${encodeURIComponent(
      publisher,
    )}/${encodeURIComponent(pack)}/versions/${encodeURIComponent(version)}/manifest.yaml`;
    const res = await this.req(url, { headers: { Accept: "application/x-yaml" } });
    if (!res.ok) {
      throw new RegistryError(
        `fetchManifest ${publisher}/${pack}@${version} → HTTP ${res.status}`,
        res.status,
      );
    }
    return await res.text();
  }

  async fetchAtomFile(
    publisher: string,
    pack: string,
    version: string,
    atomId: string,
    relPath: string,
    expectedSha256: string,
  ): Promise<Buffer> {
    const segments = relPath
      .split("/")
      .filter(Boolean)
      .map((s) => encodeURIComponent(s))
      .join("/");
    const url = `${this.baseUrl}/api/packs/${encodeURIComponent(
      publisher,
    )}/${encodeURIComponent(pack)}/versions/${encodeURIComponent(
      version,
    )}/atoms/${encodeURIComponent(atomId)}/${segments}`;
    const res = await this.req(url, { headers: { Accept: "*/*" } });
    if (!res.ok) {
      throw new RegistryError(
        `fetchAtomFile ${publisher}/${pack}@${version}/${atomId}/${relPath} → HTTP ${res.status}`,
        res.status,
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha256) {
      throw new IntegrityError(expectedSha256, actual, url);
    }
    return bytes;
  }
}
