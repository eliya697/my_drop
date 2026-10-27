/** ISO 3166-1 alpha-2, e.g. "IL". */
export type CountryCode = string;

/** ISO 4217, e.g. "USD". */
export type CurrencyCode = string;

export type Money = {
  /** Integer amount in minor units (cents). */
  amountMinor: number;
  currency: CurrencyCode;
};

export type SupplierVariant = {
  skuId: string;
  /** e.g. { Color: "Black", Size: "L" } */
  options: Readonly<Record<string, string>>;
  unitCost: Money;
  stock: number;
  imageUrl?: string;
};

export type SupplierProduct = {
  supplier: string;
  externalId: string;
  title: string;
  /** Raw supplier HTML/text. Untrusted: never render or forward to an LLM without isolation. */
  descriptionRaw: string;
  images: readonly string[];
  attributes: Readonly<Record<string, string>>;
  variants: readonly SupplierVariant[];
  sellerId: string;
  rating?: number;
  ordersCount?: number;
  /** The full upstream payload, persisted as an immutable snapshot. */
  raw: unknown;
};

export type ShippingQuote = {
  skuId: string;
  method: string;
  cost: Money;
  daysMin: number;
  daysMax: number;
  tracked: boolean;
};

export type LowestPriceVariantQuery = {
  externalProductId: string;
  shipTo: CountryCode;
  quantity: number;
  /** Only consider shipping methods that provide tracking. Default true. */
  requireTracking?: boolean;
  /** Exclude methods slower than this. */
  maxShippingDays?: number;
  /** Restrict the search to these SKUs (e.g. one color the customer picked). */
  skuIds?: readonly string[];
};

export type LowestPriceVariant = {
  variant: SupplierVariant;
  shipping: ShippingQuote;
  /** unitCost × quantity + shipping, in the supplier currency. */
  landedCost: Money;
};

export type StockCheck = {
  skuId: string;
  available: number;
  /** True when `available` covers the requested quantity. */
  sufficient: boolean;
  /** Current unit cost; fulfilment compares it with the cost at checkout to catch price jumps. */
  unitCost: Money;
  checkedAt: Date;
};

export type SupplierShippingAddress = {
  /** Latin script — suppliers reject non-Latin addresses. */
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  province?: string;
  zip: string;
  country: CountryCode;
};

export type CreateSupplierOrderInput = {
  /**
   * Stable per (our order, seller). Adapters must make retries with the same key return the
   * original order instead of creating a second one.
   */
  idempotencyKey: string;
  address: SupplierShippingAddress;
  items: readonly { skuId: string; externalProductId: string; quantity: number; shippingMethod: string }[];
  /** Free-text note shown to the seller. Must not contain customer PII beyond the address. */
  note?: string;
};

export type SupplierOrderStatus =
  "created" | "awaiting_payment" | "paid" | "shipped" | "delivered" | "cancelled";

export type SupplierOrder = {
  externalOrderId: string;
  idempotencyKey: string;
  status: SupplierOrderStatus;
  /** True when the order was created but must still be paid in the supplier account. */
  needsPayment: boolean;
  total: Money;
  createdAt: Date;
};

export type TrackingStatus =
  "pending" | "in_transit" | "out_for_delivery" | "delivered" | "exception" | "returned";

export type TrackingEvent = {
  at: Date;
  description: string;
  location?: string;
};

export type TrackingInfo = {
  externalOrderId: string;
  /** null until the seller ships. */
  trackingNumber: string | null;
  carrier: string | null;
  status: TrackingStatus;
  /** Newest first. */
  events: readonly TrackingEvent[];
  deliveredAt: Date | null;
};
