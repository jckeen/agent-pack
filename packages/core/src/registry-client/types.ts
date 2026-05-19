import type {
  RegistryPack,
  RegistryVersion,
} from "../protocol/index.js";

export interface RegistryClient {
  listVersions(publisher: string, pack: string): Promise<RegistryPack>;
  getVersion(
    publisher: string,
    pack: string,
    version: string
  ): Promise<RegistryVersion>;
  fetchManifest(
    publisher: string,
    pack: string,
    version: string
  ): Promise<string>;
  fetchAtomFile(
    publisher: string,
    pack: string,
    version: string,
    atomId: string,
    relPath: string,
    expectedSha256: string
  ): Promise<Buffer>;
}
