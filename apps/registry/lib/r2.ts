import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Raised when any of R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or
 * R2_BUCKET is unset. Route handlers catch this and return 503.
 */
export class R2NotConfiguredError extends Error {
  constructor() {
    super(
      "R2 is not configured (need R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)"
    );
    this.name = "R2NotConfiguredError";
  }
}

interface R2Handle {
  client: S3Client;
  bucket: string;
}

let _handle: R2Handle | null = null;

/**
 * Lazy singleton — initializes once per process. Throws `R2NotConfiguredError`
 * if any required env var is missing.
 */
export function r2Client(): R2Handle {
  if (_handle) return _handle;
  const endpoint = process.env["R2_ENDPOINT"];
  const accessKeyId = process.env["R2_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["R2_SECRET_ACCESS_KEY"];
  const bucket = process.env["R2_BUCKET"];
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new R2NotConfiguredError();
  }
  _handle = {
    client: new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    }),
    bucket,
  };
  return _handle;
}

/** Reset the R2 singleton — for tests only. */
export function __resetR2ForTests(): void {
  _handle = null;
}

/**
 * Produce a presigned PUT URL with an enforced `x-amz-meta-sha256` header
 * and a fixed Content-Length. The CLI must echo both back exactly on upload.
 */
export async function presignPutUrl(
  key: string,
  opts: { sha256: string; bytes: number; expiresIn?: number }
): Promise<{ url: string; headers: Record<string, string> }> {
  const { client, bucket } = r2Client();
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentLength: opts.bytes,
    Metadata: {
      sha256: opts.sha256,
    },
  });
  const url = await getSignedUrl(client, cmd, {
    expiresIn: opts.expiresIn ?? 3600,
  });
  return {
    url,
    headers: {
      "content-length": String(opts.bytes),
      "x-amz-meta-sha256": opts.sha256,
    },
  };
}

/**
 * HEAD an object. Returns null on 404. Throws any other error (including
 * R2NotConfiguredError, which the caller maps to 503).
 */
export async function headObject(
  key: string
): Promise<{ contentLength: number; etag: string } | null> {
  const { client, bucket } = r2Client();
  try {
    const res = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    return {
      contentLength: res.ContentLength ?? 0,
      etag: res.ETag ?? "",
    };
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    const name = (err as Error)?.name;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") {
      return null;
    }
    throw err;
  }
}

/**
 * GET an object and return its body as a `ReadableStream<Uint8Array>` suitable
 * for direct return from a Next.js route handler. The AWS SDK v3 stream type
 * for Node is already a `ReadableStream` in the App Router runtime.
 */
export async function streamObject(
  key: string
): Promise<{
  stream: ReadableStream<Uint8Array>;
  contentLength: number | null;
  etag: string | null;
}> {
  const { client, bucket } = r2Client();
  const res: GetObjectCommandOutput = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  const body = res.Body;
  if (!body) {
    throw new Error(`R2 returned empty body for key ${key}`);
  }
  // AWS SDK v3 returns a web `ReadableStream` in Edge/Node 18+ runtimes when
  // run under Next.js. transformToWebStream() is the canonical converter when
  // the type is ambiguous.
  const maybeWeb = body as unknown as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
  };
  const stream =
    typeof maybeWeb.transformToWebStream === "function"
      ? maybeWeb.transformToWebStream()
      : (body as unknown as ReadableStream<Uint8Array>);
  return {
    stream,
    contentLength: res.ContentLength ?? null,
    etag: res.ETag ?? null,
  };
}
