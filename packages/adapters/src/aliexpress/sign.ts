import { createHmac } from "node:crypto";

/**
 * AliExpress Open Platform request signature (verified against the official "Signature
 * algorithm" and "HTTP request sample" docs, including both published test vectors):
 *
 *  1. sort all parameters except `sign` by name (ASCII order);
 *  2. concatenate name+value for each, skipping empty values;
 *  3. for system APIs (/auth/...), prefix the API path;
 *  4. HMAC-SHA256 with the app secret, UTF-8, upper-case hex.
 *
 * Business APIs include `method` as a regular parameter and use no prefix.
 */
export function signRequest(
  params: Readonly<Record<string, string>>,
  appSecret: string,
  systemApiPath?: string,
): string {
  const payload =
    (systemApiPath ?? "") +
    Object.keys(params)
      .filter((key) => key !== "sign" && params[key] !== "" && params[key] !== undefined)
      .sort()
      .map((key) => `${key}${params[key]}`)
      .join("");
  return createHmac("sha256", appSecret).update(payload, "utf8").digest("hex").toUpperCase();
}
