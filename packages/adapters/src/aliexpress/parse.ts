/**
 * Parsers for the gateway's loosely typed JSON: numbers arrive as strings ("3.94", "57",
 * "1000+", "true"), and lists may be wrapped in a single-key object depending on the response
 * mode. All parsers are strict: malformed money throws instead of silently becoming 0.
 */

export class MalformedPayloadError extends Error {
  constructor(
    readonly field: string,
    readonly value: unknown,
  ) {
    super(`malformed supplier payload at ${field}: ${JSON.stringify(value)?.slice(0, 80)}`);
    this.name = "MalformedPayloadError";
  }
}

/**
 * Decimal major-unit string → integer minor units, without floating point:
 * "3.94" → 394, "12" → 1200, "0.5" → 50. Rejects negatives, >2 decimals, and garbage.
 */
export function parseMoneyMinor(value: unknown, field: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new MalformedPayloadError(field, value);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function parseIntStrict(value: unknown, field: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,15}$/.test(text)) throw new MalformedPayloadError(field, value);
  return Number(text);
}

/** "1000+" → 1000, "5,000+" → 5000; undefined when absent or unparseable (informational only). */
export function parseLooseCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const digits = String(value).replace(/[,\s]/g, "").match(/^\d+/);
  return digits ? Number(digits[0]) : undefined;
}

/** "4.8" → 4.8; undefined when absent or out of the 0–5 range. */
export function parseRating(value: unknown): number | undefined {
  const n = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(n) && n >= 0 && n <= 5
    ? n
    : undefined;
}

export const parseBool = (value: unknown): boolean => value === true || value === "true";

export const str = (value: unknown): string | undefined =>
  value === undefined || value === null || value === "" ? undefined : String(value);

/**
 * Lists may be returned directly (`[...]`) or wrapped (`{ "ae_item_sku_info_d_t_o": [...] }`).
 * Returns the array either way; a missing value is an empty list.
 */
export function unwrapList(value: unknown): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (typeof value === "object") {
    const inner = Object.values(value as Record<string, unknown>);
    if (inner.length === 1) {
      const only = inner[0];
      if (Array.isArray(only)) return only as Record<string, unknown>[];
      if (only && typeof only === "object") return [only as Record<string, unknown>];
    }
  }
  throw new MalformedPayloadError("list", value);
}

/**
 * Business responses are either `{ result: ... }` (simplified) or
 * `{ aliexpress_ds_product_get_response: { result: ... } }`. Returns the object holding `result`.
 */
export function unwrapResponse(body: Record<string, unknown>, method: string): Record<string, unknown> {
  const key = `${method.replace(/\./g, "_")}_response`;
  const inner = body[key];
  return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : body;
}
