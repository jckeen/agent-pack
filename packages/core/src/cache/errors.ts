export class BlobNotFoundError extends Error {
  override name = "BlobNotFoundError";
  constructor(public readonly sha256: string) {
    super(`blob not found in cache: ${sha256}`);
  }
}

export class IntegrityError extends Error {
  override name = "IntegrityError";
  constructor(
    public readonly expectedSha256: string,
    public readonly actualSha256: string,
    public readonly url?: string
  ) {
    super(
      `integrity check failed: expected ${expectedSha256}, got ${actualSha256}${
        url ? ` (url: ${url})` : ""
      }`
    );
  }
}
