export class RegistryError extends Error {
  override name = "RegistryError";
  constructor(
    message: string,
    public readonly status?: number,
    public readonly errorName?: string
  ) {
    super(message);
  }
}

export class VersionNotFoundError extends RegistryError {
  override name = "VersionNotFoundError";
  constructor(publisher: string, pack: string, version?: string) {
    super(
      `version not found: ${publisher}/${pack}${version ? `@${version}` : ""}`,
      404,
      "not_found"
    );
  }
}

export { IntegrityError } from "../cache/errors.js";
