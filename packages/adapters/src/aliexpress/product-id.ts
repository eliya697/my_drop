export class InvalidProductReferenceError extends Error {
  readonly code = "INVALID_PRODUCT_REFERENCE";

  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(`${reason}: ${input.slice(0, 200)}`);
    this.name = "InvalidProductReferenceError";
  }
}

const ID = /^\d{8,20}$/;
const HOST = /(^|\.)aliexpress\.(com|us|ru)$/i;

/**
 * Extracts the numeric product id from what an admin pastes: a bare id, or any AliExpress
 * product URL (country subdomains, mobile, `.us`, with or without query strings):
 *
 *   1005006123456789
 *   https://www.aliexpress.com/item/1005006123456789.html?spm=...
 *   https://he.aliexpress.com/item/1005006123456789.html
 *   https://m.aliexpress.com/item/1005006123456789.html
 *
 * Short links (a.aliexpress.com/_xyz, s.click.aliexpress.com) are rejected: resolving them
 * requires following a redirect to an untrusted destination.
 */
export function parseAliExpressProductId(input: string): string {
  const raw = input.trim();
  if (ID.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidProductReferenceError(raw, "not a product id or URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidProductReferenceError(raw, "unsupported URL scheme");
  }
  if (!HOST.test(url.hostname)) throw new InvalidProductReferenceError(raw, "not an AliExpress URL");

  const match = /\/item\/(?:[^/]+\/)?(\d{8,20})\.html$/i.exec(url.pathname);
  if (match) return match[1]!;

  if (/^(a|s\.click)\./i.test(url.hostname)) {
    throw new InvalidProductReferenceError(
      raw,
      "short links are not supported; open it and paste the full product URL",
    );
  }
  throw new InvalidProductReferenceError(raw, "URL does not point to a product page");
}
