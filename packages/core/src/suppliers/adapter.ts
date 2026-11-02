import { NoEligibleVariantError } from "./errors";
import type {
  CountryCode,
  CreateSupplierOrderInput,
  LowestPriceVariant,
  LowestPriceVariantQuery,
  ShippingQuote,
  ShippingQuoteQuery,
  StockCheck,
  SupplierOrder,
  SupplierProduct,
  SupplierVariant,
  TrackingInfo,
} from "./types";

/**
 * Read side of a supplier (AliExpress, CJ, a local warehouse): catalog, shipping, stock.
 * Implementations live in packages/adapters and must:
 *  - return amounts as integer minor units with an explicit currency,
 *  - throw only `SupplierError` subclasses (classified as retryable or not).
 */
export interface SupplierCatalog {
  /** Stable identifier stored in `products.supplier`, e.g. "aliexpress". */
  readonly name: string;

  /** Full product with variants; used by import and periodic re-sync. */
  getProduct(externalProductId: string, shipTo: CountryCode): Promise<SupplierProduct>;

  /** Every shipping option the supplier offers for one SKU to `shipTo`. */
  quoteShipping(query: ShippingQuoteQuery): Promise<ShippingQuote[]>;

  /**
   * The in-stock variant with the lowest landed cost (unit cost × quantity + shipping) to
   * `shipTo`, honoring the query's tracking/speed constraints.
   * @throws NoEligibleVariantError when nothing qualifies.
   */
  getLowestPriceVariant(query: LowestPriceVariantQuery): Promise<LowestPriceVariant>;

  /** Live stock and unit cost for one SKU — called immediately before placing an order. */
  checkStock(externalProductId: string, skuId: string, quantity: number): Promise<StockCheck>;
}

/**
 * Write side of a supplier: placing and following orders. `createSupplierOrder` must be
 * idempotent on `idempotencyKey`.
 */
export interface SupplierFulfillment {
  readonly name: string;

  /** Places the order with the supplier. Retrying with the same idempotency key is safe. */
  createSupplierOrder(input: CreateSupplierOrderInput): Promise<SupplierOrder>;

  /** Current status of a previously created order (e.g. to confirm supplier payment). */
  getSupplierOrder(externalOrderId: string): Promise<SupplierOrder>;

  getTrackingInfo(externalOrderId: string): Promise<TrackingInfo>;
}

/** A supplier we can both source from and place orders with. */
export interface SupplierAdapter extends SupplierCatalog, SupplierFulfillment {
  readonly name: string;
}

/**
 * Pure selection logic shared by every adapter's `getLowestPriceVariant`: given variants and the
 * shipping quotes for them, pick the cheapest landed combination that satisfies the query.
 * Ties are broken by faster delivery, then by SKU id for determinism.
 */
export function selectLowestPriceVariant(
  supplier: string,
  variants: readonly SupplierVariant[],
  quotes: readonly ShippingQuote[],
  query: Pick<LowestPriceVariantQuery, "quantity" | "requireTracking" | "maxShippingDays" | "skuIds">,
): LowestPriceVariant {
  if (!Number.isSafeInteger(query.quantity) || query.quantity <= 0) {
    throw new RangeError("quantity must be a positive integer");
  }
  const requireTracking = query.requireTracking ?? true;
  const skuFilter = query.skuIds ? new Set(query.skuIds) : null;

  let best: LowestPriceVariant | null = null;
  for (const variant of variants) {
    if (skuFilter && !skuFilter.has(variant.skuId)) continue;
    if (variant.stock < query.quantity) continue;

    for (const shipping of quotes) {
      if (shipping.skuId !== variant.skuId) continue;
      if (requireTracking && !shipping.tracked) continue;
      if (query.maxShippingDays !== undefined && shipping.daysMax > query.maxShippingDays) continue;
      if (shipping.cost.currency !== variant.unitCost.currency) {
        throw new RangeError(
          `currency mismatch for sku ${variant.skuId}: ${variant.unitCost.currency} vs ${shipping.cost.currency}`,
        );
      }

      const candidate: LowestPriceVariant = {
        variant,
        shipping,
        landedCost: {
          amountMinor: variant.unitCost.amountMinor * query.quantity + shipping.cost.amountMinor,
          currency: variant.unitCost.currency,
        },
      };
      if (best === null || isBetter(candidate, best)) best = candidate;
    }
  }

  if (best === null) throw new NoEligibleVariantError(supplier, "no in-stock variant matches the query");
  return best;
}

function isBetter(a: LowestPriceVariant, b: LowestPriceVariant): boolean {
  if (a.landedCost.amountMinor !== b.landedCost.amountMinor) {
    return a.landedCost.amountMinor < b.landedCost.amountMinor;
  }
  if (a.shipping.daysMax !== b.shipping.daysMax) return a.shipping.daysMax < b.shipping.daysMax;
  return a.variant.skuId < b.variant.skuId;
}
