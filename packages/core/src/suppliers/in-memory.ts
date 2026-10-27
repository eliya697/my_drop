import { selectLowestPriceVariant, type SupplierAdapter } from "./adapter";
import { SupplierNotFoundError, SupplierOutOfStockError } from "./errors";
import type {
  CountryCode,
  CreateSupplierOrderInput,
  LowestPriceVariant,
  LowestPriceVariantQuery,
  ShippingQuote,
  StockCheck,
  SupplierOrder,
  SupplierProduct,
  TrackingInfo,
} from "./types";

/**
 * A complete, deterministic SupplierAdapter backed by memory. Used by unit tests across the
 * monorepo and by staging runs with FEATURE_DRY_RUN_FULFILLMENT. It honors the same contract as
 * real adapters: idempotent order creation, stock decrement, and typed errors.
 */
export class InMemorySupplierAdapter implements SupplierAdapter {
  readonly name: string;
  private readonly products = new Map<string, SupplierProduct>();
  private readonly quotes = new Map<string, ShippingQuote[]>();
  private readonly orders = new Map<string, SupplierOrder>();
  private readonly ordersByKey = new Map<string, string>();
  private readonly tracking = new Map<string, TrackingInfo>();
  private readonly now: () => Date;
  /** When true, orders are charged automatically (status "paid"), like supplier auto-pay. */
  private readonly autoPay: boolean;
  private sequence = 0;

  constructor(opts: { name?: string; now?: () => Date; autoPay?: boolean } = {}) {
    this.name = opts.name ?? "in-memory";
    this.now = opts.now ?? (() => new Date());
    this.autoPay = opts.autoPay ?? false;
  }

  // ---- seeding ---------------------------------------------------------------------------

  addProduct(product: SupplierProduct, quotes: readonly ShippingQuote[]): this {
    this.products.set(product.externalId, structuredClone(product));
    this.quotes.set(product.externalId, [...quotes]);
    return this;
  }

  setTracking(info: TrackingInfo): this {
    this.tracking.set(info.externalOrderId, info);
    return this;
  }

  /** Simulate the supplier's side moving an order forward (payment, shipment, ...). */
  setOrderStatus(externalOrderId: string, status: SupplierOrder["status"]): this {
    const order = this.requireOrder(externalOrderId);
    this.orders.set(externalOrderId, { ...order, status, needsPayment: status === "awaiting_payment" });
    return this;
  }

  // ---- SupplierAdapter -------------------------------------------------------------------

  async getProduct(externalProductId: string, _shipTo: CountryCode): Promise<SupplierProduct> {
    return structuredClone(this.requireProduct(externalProductId));
  }

  async getLowestPriceVariant(query: LowestPriceVariantQuery): Promise<LowestPriceVariant> {
    const product = this.requireProduct(query.externalProductId);
    return selectLowestPriceVariant(
      this.name,
      product.variants,
      this.quotes.get(product.externalId) ?? [],
      query,
    );
  }

  async checkStock(externalProductId: string, skuId: string, quantity: number): Promise<StockCheck> {
    const variant = this.requireVariant(externalProductId, skuId);
    return {
      skuId,
      available: variant.stock,
      sufficient: variant.stock >= quantity,
      unitCost: { ...variant.unitCost },
      checkedAt: this.now(),
    };
  }

  async createSupplierOrder(input: CreateSupplierOrderInput): Promise<SupplierOrder> {
    const existingId = this.ordersByKey.get(input.idempotencyKey);
    if (existingId) return { ...this.requireOrder(existingId) };

    if (input.items.length === 0) throw new RangeError("order has no items");

    // Validate everything before mutating anything, so a failure leaves no partial order.
    let currency: string | null = null;
    let total = 0;
    for (const item of input.items) {
      const variant = this.requireVariant(item.externalProductId, item.skuId);
      if (variant.stock < item.quantity) {
        throw new SupplierOutOfStockError(this.name, item.skuId, item.quantity, variant.stock);
      }
      const quote = (this.quotes.get(item.externalProductId) ?? []).find(
        (q) => q.skuId === item.skuId && q.method === item.shippingMethod,
      );
      if (!quote) throw new SupplierNotFoundError(this.name, "sku", `${item.skuId}@${item.shippingMethod}`);
      currency ??= variant.unitCost.currency;
      if (variant.unitCost.currency !== currency || quote.cost.currency !== currency) {
        throw new RangeError(
          `order mixes currencies (${currency}, ${variant.unitCost.currency}, ${quote.cost.currency})`,
        );
      }
      total += variant.unitCost.amountMinor * item.quantity + quote.cost.amountMinor;
    }

    for (const item of input.items) {
      const variant = this.requireVariant(item.externalProductId, item.skuId);
      (variant as { stock: number }).stock -= item.quantity;
    }

    const order: SupplierOrder = {
      externalOrderId: `${this.name}-${++this.sequence}`,
      idempotencyKey: input.idempotencyKey,
      status: this.autoPay ? "paid" : "awaiting_payment",
      needsPayment: !this.autoPay,
      total: { amountMinor: total, currency: currency! },
      createdAt: this.now(),
    };
    this.orders.set(order.externalOrderId, order);
    this.ordersByKey.set(input.idempotencyKey, order.externalOrderId);
    return { ...order };
  }

  async getSupplierOrder(externalOrderId: string): Promise<SupplierOrder> {
    return { ...this.requireOrder(externalOrderId) };
  }

  async getTrackingInfo(externalOrderId: string): Promise<TrackingInfo> {
    this.requireOrder(externalOrderId);
    return (
      this.tracking.get(externalOrderId) ?? {
        externalOrderId,
        trackingNumber: null,
        carrier: null,
        status: "pending",
        events: [],
        deliveredAt: null,
      }
    );
  }

  // ---- helpers ---------------------------------------------------------------------------

  private requireProduct(id: string): SupplierProduct {
    const product = this.products.get(id);
    if (!product) throw new SupplierNotFoundError(this.name, "product", id);
    return product;
  }

  private requireVariant(productId: string, skuId: string) {
    const variant = this.requireProduct(productId).variants.find((v) => v.skuId === skuId);
    if (!variant) throw new SupplierNotFoundError(this.name, "sku", skuId);
    return variant;
  }

  private requireOrder(id: string): SupplierOrder {
    const order = this.orders.get(id);
    if (!order) throw new SupplierNotFoundError(this.name, "order", id);
    return order;
  }
}
