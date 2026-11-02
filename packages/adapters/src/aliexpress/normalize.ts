import type { ShippingQuote, SupplierProduct, SupplierVariant } from "@dropship/core";
import {
  MalformedPayloadError,
  parseBool,
  parseIntStrict,
  parseLooseCount,
  parseMoneyMinor,
  parseRating,
  str,
  unwrapList,
} from "./parse";

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (value && typeof value === "object" ? (value as Json) : {});

/**
 * `aliexpress.ds.product.get` `result` → SupplierProduct.
 *
 * Price: `offer_sale_price` (the price we actually pay, after the seller's current discount)
 * falls back to `sku_price`. Options: `property_value_definition_name` (the seller's label,
 * e.g. "Black Green") falls back to `sku_property_value` (AliExpress's generic value).
 */
export function normalizeProduct(result: Json, requestedId: string, raw: unknown): SupplierProduct {
  const base = obj(result.ae_item_base_info_dto);
  const media = obj(result.ae_multimedia_info_dto);
  const store = obj(result.ae_store_info);

  const title = str(base.subject);
  if (!title) throw new MalformedPayloadError("ae_item_base_info_dto.subject", base.subject);

  const variants = unwrapList(result.ae_item_sku_info_dtos).map((sku, i) => normalizeSku(sku, i));
  if (variants.length === 0)
    throw new MalformedPayloadError("ae_item_sku_info_dtos", result.ae_item_sku_info_dtos);

  const images = (str(media.image_urls) ?? "")
    .split(";")
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u));

  const attributes: Record<string, string> = {};
  for (const prop of unwrapList(result.ae_item_properties)) {
    const name = str(prop.attr_name);
    const value = str(prop.attr_value);
    if (!name || !value) continue;
    attributes[name] = attributes[name] ? `${attributes[name]}, ${value}` : value;
  }

  const status = str(base.product_status_type);
  return {
    supplier: "aliexpress",
    externalId: requestedId,
    title,
    descriptionRaw: str(base.detail) ?? str(base.mobile_detail) ?? "",
    images: [...new Set(images)],
    attributes,
    variants,
    sellerId: str(store.store_id) ?? "unknown",
    available: status === undefined || status === "onSelling",
    rating: parseRating(base.avg_evaluation_rating),
    ordersCount: parseLooseCount(base.sales_count),
    raw,
  };
}

function normalizeSku(sku: Json, index: number): SupplierVariant {
  const path = `ae_item_sku_info_dtos[${index}]`;
  const skuId = str(sku.sku_id);
  if (!skuId) throw new MalformedPayloadError(`${path}.sku_id`, sku.sku_id);
  const currency = str(sku.currency_code);
  if (!currency || !/^[A-Z]{3}$/.test(currency))
    throw new MalformedPayloadError(`${path}.currency_code`, sku.currency_code);

  const priceField = str(sku.offer_sale_price) !== undefined ? "offer_sale_price" : "sku_price";
  const amountMinor = parseMoneyMinor(sku[priceField], `${path}.${priceField}`);

  const options: Record<string, string> = {};
  let imageUrl: string | undefined;
  for (const prop of unwrapList(sku.ae_sku_property_dtos)) {
    const name = str(prop.sku_property_name);
    const value = str(prop.property_value_definition_name) ?? str(prop.sku_property_value);
    if (name && value) options[name] = value;
    imageUrl ??= str(prop.sku_image);
  }

  return {
    skuId,
    options,
    unitCost: { amountMinor, currency },
    stock:
      sku.sku_available_stock === undefined
        ? 0
        : parseIntStrict(sku.sku_available_stock, `${path}.sku_available_stock`),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

/**
 * `aliexpress.ds.freight.query` `result` → ShippingQuote[].
 *
 * Despite its name, `shipping_fee_cent` holds the fee in MAJOR units ("1.99" alongside
 * `shipping_fee_format: "US $1.99"` in the official example), so it goes through the decimal
 * parser like every other price. Options with malformed fees are skipped, not guessed.
 */
export function normalizeFreight(result: Json, skuId: string): ShippingQuote[] {
  const quotes: ShippingQuote[] = [];
  for (const option of unwrapList(result.delivery_options)) {
    const method = str(option.code);
    if (!method) continue;
    const free = parseBool(option.free_shipping);
    const currency = str(option.shipping_fee_currency) ?? "USD";
    let amountMinor: number;
    try {
      amountMinor = free
        ? 0
        : parseMoneyMinor(option.shipping_fee_cent, "delivery_options.shipping_fee_cent");
    } catch {
      continue;
    }
    const daysMin = Number(option.min_delivery_days);
    const daysMax = Number(option.max_delivery_days);
    if (!Number.isInteger(daysMax) || daysMax <= 0) continue;

    quotes.push({
      skuId,
      method,
      carrier: str(option.company),
      cost: { amountMinor, currency },
      daysMin: Number.isInteger(daysMin) && daysMin > 0 && daysMin <= daysMax ? daysMin : daysMax,
      daysMax,
      tracked: parseBool(option.tracking),
    });
  }
  return quotes;
}
