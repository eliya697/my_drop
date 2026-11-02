import { createHash } from "node:crypto";
import sharp from "sharp";

export class ImageRejectedError extends Error {
  readonly code = "IMAGE_REJECTED";
  /** False for permanent problems (bad host, not an image); true for network/5xx. */
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ImageRejectedError";
  }
}

/** Supplier image CDNs. Anything else is refused: image URLs come from untrusted payloads. */
export const DEFAULT_ALLOWED_IMAGE_HOSTS = [
  /(^|\.)alicdn\.com$/i,
  /(^|\.)aliexpress-media\.com$/i,
  /(^|\.)aliexpress\.com$/i,
];

export type FetchImageOptions = {
  allowedHosts?: readonly RegExp[];
  maxBytes?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/**
 * Downloads an image with SSRF and resource limits: https only, allow-listed hosts, no redirects
 * to other hosts, image content types only, streamed with a hard byte cap.
 */
export async function fetchImage(rawUrl: string, opts: FetchImageOptions = {}): Promise<Uint8Array> {
  const allowed = opts.allowedHosts ?? DEFAULT_ALLOWED_IMAGE_HOSTS;
  const maxBytes = opts.maxBytes ?? 15 * 1024 * 1024;

  let url: URL;
  try {
    url = new URL(rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl);
  } catch {
    throw new ImageRejectedError(`invalid image URL: ${rawUrl.slice(0, 200)}`, false);
  }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") throw new ImageRejectedError(`unsupported scheme ${url.protocol}`, false);
  if (!allowed.some((re) => re.test(url.hostname))) {
    throw new ImageRejectedError(`host not allowed: ${url.hostname}`, false);
  }

  let response: Response;
  try {
    response = await (opts.fetch ?? fetch)(url, {
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      headers: { accept: "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8" },
    });
  } catch (err) {
    throw new ImageRejectedError(`download failed: ${(err as Error).message}`, true);
  }
  if (response.status === 404 || response.status === 410)
    throw new ImageRejectedError(`HTTP ${response.status}`, false);
  if (!response.ok)
    throw new ImageRejectedError(
      `HTTP ${response.status}`,
      response.status >= 500 || response.status === 429,
    );

  const type = response.headers.get("content-type") ?? "";
  if (!/^image\//i.test(type))
    throw new ImageRejectedError(`not an image: ${type || "no content-type"}`, false);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new ImageRejectedError(`too large: ${declared} bytes`, false);
  if (!response.body) throw new ImageRejectedError("empty body", true);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ImageRejectedError(`too large: over ${maxBytes} bytes`, false);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export type ProcessedImage = { data: Buffer; width: number; height: number; contentType: "image/webp" };

/**
 * Normalizes an untrusted image for the storefront: decodes it (rejecting anything that is not
 * a real raster image), applies EXIF orientation, strips all metadata, bounds its size, and
 * re-encodes to WebP.
 */
export async function processImage(
  input: Uint8Array,
  opts: { maxDimension?: number; quality?: number } = {},
): Promise<ProcessedImage> {
  const maxDimension = opts.maxDimension ?? 1600;
  try {
    const pipeline = sharp(input, { failOn: "error", limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
      .webp({ quality: opts.quality ?? 82 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    if (info.width < 100 || info.height < 100)
      throw new ImageRejectedError(`too small: ${info.width}x${info.height}`, false);
    return { data, width: info.width, height: info.height, contentType: "image/webp" };
  } catch (err) {
    if (err instanceof ImageRejectedError) throw err;
    throw new ImageRejectedError(`undecodable image: ${(err as Error).message}`, false);
  }
}

/** Deterministic object key: the same source image always maps to the same object (idempotent). */
export function productImageKey(productId: string, sourceUrl: string): string {
  const hash = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 24);
  return `products/${productId}/${hash}.webp`;
}
