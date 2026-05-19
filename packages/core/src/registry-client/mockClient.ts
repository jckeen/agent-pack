/**
 * `InMemoryRegistryClient` — fixture-backed registry for tests.
 */

import { createHash } from "node:crypto";

import type {
  RegistryPack,
  RegistryVersion,
} from "../protocol/index.js";

import {
  IntegrityError,
  VersionNotFoundError,
} from "./errors.js";
import type { RegistryClient } from "./types.js";

export interface InMemoryFixture {
  packs: Map<string, RegistryPack>;
  versions: Map<string, RegistryVersion>;
  manifests: Map<string, string>;
  blobs: Map<string, Buffer>;
}

export function makeFixture(): InMemoryFixture {
  return {
    packs: new Map(),
    versions: new Map(),
    manifests: new Map(),
    blobs: new Map(),
  };
}

export class InMemoryRegistryClient implements RegistryClient {
  constructor(private readonly fixture: InMemoryFixture) {}

  async listVersions(publisher: string, pack: string): Promise<RegistryPack> {
    const key = `${publisher}/${pack}`;
    const pkg = this.fixture.packs.get(key);
    if (!pkg) throw new VersionNotFoundError(publisher, pack);
    return pkg;
  }

  async getVersion(
    publisher: string,
    pack: string,
    version: string
  ): Promise<RegistryVersion> {
    const key = `${publisher}/${pack}@${version}`;
    const v = this.fixture.versions.get(key);
    if (!v) throw new VersionNotFoundError(publisher, pack, version);
    return v;
  }

  async fetchManifest(
    publisher: string,
    pack: string,
    version: string
  ): Promise<string> {
    const key = `${publisher}/${pack}@${version}`;
    const m = this.fixture.manifests.get(key);
    if (!m) throw new VersionNotFoundError(publisher, pack, version);
    return m;
  }

  async fetchAtomFile(
    publisher: string,
    pack: string,
    version: string,
    atomId: string,
    relPath: string,
    expectedSha256: string
  ): Promise<Buffer> {
    const key = `${publisher}/${pack}@${version}/${atomId}/${relPath}`;
    const bytes = this.fixture.blobs.get(key);
    if (!bytes) throw new VersionNotFoundError(publisher, pack, version);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedSha256) {
      throw new IntegrityError(expectedSha256, actual, `mock://${key}`);
    }
    return bytes;
  }
}
