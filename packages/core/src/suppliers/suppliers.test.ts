import { beforeEach, describe, expect, it } from "vitest";
import { selectLowestPriceVariant } from "./adapter";
import {
  isRetryableSupplierError,
  NoEligibleVariantError,
  SupplierAuthError,
  SupplierNotFoundError,
  SupplierOutOfStockError,
  SupplierRateLimitError,
  SupplierUnavailableError,
} from "./errors";
import { InMemorySupplierAdapter } from "./in-memory";
import type { CreateSupplierOrderInput, ShippingQuote, SupplierProduct, SupplierVariant } from "./types";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

const variant = (skuId: string, cost: number, stock: number): SupplierVariant => ({
  skuId,
  options: { Color: skuId },
  unitCost: usd(cost),
  stock,
});

const quote = (
  skuId: string,
  method: string,
  cost: number,
  daysMax: number,
  tracked = true,
): ShippingQuote => ({
  skuId,
  method,
  cost: usd(cost),
  daysMin: Math.max(1, daysMax - 7),
  daysMax,
  tracked,
});

const VARIANTS = [variant("black", 1000, 50), variant("white", 900, 0), variant("red", 950, 3)];
const QUOTES = [
  quote("black", "standard", 200, 20),
  quote("black", "economy", 0, 45, false),
  quote("white", "standard", 100, 20),
  quote("red", "standard", 300, 20),
  quote("red", "express", 900, 8),
];

describe("selectLowestPriceVariant", () => {
  it("picks the lowest landed cost among in-stock, tracked options", () => {
    // white is cheapest but out of stock; black-economy is untracked; black-standard = 1200, red = 1250
    const best = selectLowestPriceVariant("s", VARIANTS, QUOTES, { quantity: 1 });
    expect(best.variant.skuId).toBe("black");
    expect(best.shipping.method).toBe("standard");
    expect(best.landedCost).toEqual(usd(1200));
  });

  it("includes untracked shipping when allowed", () => {
    const best = selectLowestPriceVariant("s", VARIANTS, QUOTES, { quantity: 1, requireTracking: false });
    expect(best.shipping.method).toBe("economy");
    expect(best.landedCost).toEqual(usd(1000));
  });

  it("multiplies unit cost by quantity but charges shipping once", () => {
    const best = selectLowestPriceVariant("s", VARIANTS, QUOTES, { quantity: 3 });
    // black: 3000 + 200 = 3200; red: 2850 + 300 = 3150
    expect(best.variant.skuId).toBe("red");
    expect(best.landedCost).toEqual(usd(3150));
  });

  it("skips variants without enough stock for the quantity", () => {
    const best = selectLowestPriceVariant("s", VARIANTS, QUOTES, { quantity: 4 });
    expect(best.variant.skuId).toBe("black");
  });

  it("honors the delivery-speed limit", () => {
    const best = selectLowestPriceVariant("s", VARIANTS, QUOTES, { quantity: 1, maxShippingDays: 10 });
    expect(best.shipping.method).toBe("express");
  });

  it("restricts to the requested SKUs", () => {
    expect(
      selectLowestPriceVariant("s", VARIANTS, QUOTES, { quantity: 1, skuIds: ["red"] }).variant.skuId,
    ).toBe("red");
  });

  it("breaks cost ties by faster delivery, then by SKU", () => {
    const variants = [variant("b", 1000, 5), variant("a", 1000, 5)];
    const quotes = [quote("a", "slow", 100, 30), quote("b", "fast", 100, 10)];
    expect(selectLowestPriceVariant("s", variants, quotes, { quantity: 1 }).variant.skuId).toBe("b");
    const sameSpeed = [quote("a", "x", 100, 10), quote("b", "x", 100, 10)];
    expect(selectLowestPriceVariant("s", variants, sameSpeed, { quantity: 1 }).variant.skuId).toBe("a");
  });

  it("throws NoEligibleVariantError when nothing qualifies", () => {
    expect(() => selectLowestPriceVariant("s", VARIANTS, QUOTES, { quantity: 1000 })).toThrow(
      NoEligibleVariantError,
    );
  });

  it("rejects a non-positive or fractional quantity", () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(() => selectLowestPriceVariant("s", VARIANTS, QUOTES, { quantity })).toThrow(RangeError);
    }
  });

  it("refuses to compare amounts in different currencies", () => {
    const quotes = [{ ...quote("black", "standard", 200, 20), cost: { amountMinor: 200, currency: "CNY" } }];
    expect(() => selectLowestPriceVariant("s", VARIANTS, quotes, { quantity: 1 })).toThrow(
      /currency mismatch/,
    );
  });
});

describe("supplier errors", () => {
  it("classifies retryable failures", () => {
    expect(isRetryableSupplierError(new SupplierUnavailableError("ae", "timeout"))).toBe(true);
    expect(isRetryableSupplierError(new SupplierRateLimitError("ae", 1000))).toBe(true);
    expect(isRetryableSupplierError(new SupplierAuthError("ae", "token expired"))).toBe(false);
    expect(isRetryableSupplierError(new SupplierOutOfStockError("ae", "sku", 2, 0))).toBe(false);
    expect(isRetryableSupplierError(new Error("random"))).toBe(false);
  });

  it("carries a stable code and the supplier name", () => {
    const err = new SupplierNotFoundError("aliexpress", "product", "123");
    expect(err.code).toBe("SUPPLIER_NOT_FOUND");
    expect(err.message).toBe("aliexpress: product 123 not found");
    expect(err.name).toBe("SupplierNotFoundError");
  });
});

describe("InMemorySupplierAdapter (SupplierAdapter contract)", () => {
  const PRODUCT: SupplierProduct = {
    supplier: "in-memory",
    externalId: "p1",
    title: "Lamp",
    descriptionRaw: "<p>Lamp</p>",
    images: [],
    attributes: {},
    variants: VARIANTS,
    sellerId: "seller-1",
    available: true,
    raw: {},
  };
  const now = new Date("2026-10-27T12:00:00Z");
  let adapter: InMemorySupplierAdapter;

  const orderInput = (overrides: Partial<CreateSupplierOrderInput> = {}): CreateSupplierOrderInput => ({
    idempotencyKey: "order-1:seller-1",
    address: {
      fullName: "Dana Levi",
      phone: "+972500000000",
      line1: "Herzl 1",
      city: "Tel Aviv",
      zip: "6100000",
      country: "IL",
    },
    items: [{ externalProductId: "p1", skuId: "black", quantity: 2, shippingMethod: "standard" }],
    ...overrides,
  });

  beforeEach(() => {
    adapter = new InMemorySupplierAdapter({ now: () => now }).addProduct(PRODUCT, QUOTES);
  });

  it("returns a copy of the product, not shared state", async () => {
    const p = await adapter.getProduct("p1", "IL");
    (p.variants[0] as { stock: number }).stock = 0;
    expect((await adapter.checkStock("p1", "black", 1)).available).toBe(50);
  });

  it("finds the lowest-price variant", async () => {
    const best = await adapter.getLowestPriceVariant({ externalProductId: "p1", shipTo: "IL", quantity: 1 });
    expect(best.variant.skuId).toBe("black");
  });

  it("checks stock against the requested quantity", async () => {
    expect(await adapter.checkStock("p1", "red", 3)).toMatchObject({
      available: 3,
      sufficient: true,
      checkedAt: now,
    });
    expect(await adapter.checkStock("p1", "red", 4)).toMatchObject({ sufficient: false });
  });

  it("creates an order, decrements stock, and totals cost plus shipping", async () => {
    const order = await adapter.createSupplierOrder(orderInput());
    expect(order).toMatchObject({ status: "awaiting_payment", needsPayment: true, total: usd(2200) });
    expect((await adapter.checkStock("p1", "black", 1)).available).toBe(48);
  });

  it("is idempotent on the idempotency key", async () => {
    const first = await adapter.createSupplierOrder(orderInput());
    const retry = await adapter.createSupplierOrder(orderInput());
    expect(retry.externalOrderId).toBe(first.externalOrderId);
    expect((await adapter.checkStock("p1", "black", 1)).available).toBe(48);
    const other = await adapter.createSupplierOrder(orderInput({ idempotencyKey: "order-2:seller-1" }));
    expect(other.externalOrderId).not.toBe(first.externalOrderId);
  });

  it("marks orders paid when the supplier charges automatically", async () => {
    const autoPay = new InMemorySupplierAdapter({ autoPay: true }).addProduct(PRODUCT, QUOTES);
    expect(await autoPay.createSupplierOrder(orderInput())).toMatchObject({
      status: "paid",
      needsPayment: false,
    });
  });

  it("rejects out-of-stock orders without side effects", async () => {
    const input = orderInput({
      items: [
        { externalProductId: "p1", skuId: "black", quantity: 1, shippingMethod: "standard" },
        { externalProductId: "p1", skuId: "red", quantity: 10, shippingMethod: "standard" },
      ],
    });
    await expect(adapter.createSupplierOrder(input)).rejects.toBeInstanceOf(SupplierOutOfStockError);
    expect((await adapter.checkStock("p1", "black", 1)).available).toBe(50);
  });

  it("rejects an unknown shipping method", async () => {
    const input = orderInput({
      items: [{ externalProductId: "p1", skuId: "black", quantity: 1, shippingMethod: "teleport" }],
    });
    await expect(adapter.createSupplierOrder(input)).rejects.toBeInstanceOf(SupplierNotFoundError);
  });

  it("reports pending tracking until the seller ships, then the stored tracking", async () => {
    const order = await adapter.createSupplierOrder(orderInput());
    expect(await adapter.getTrackingInfo(order.externalOrderId)).toMatchObject({
      status: "pending",
      trackingNumber: null,
    });
    adapter.setTracking({
      externalOrderId: order.externalOrderId,
      trackingNumber: "LP123456789CN",
      carrier: "Cainiao",
      status: "in_transit",
      events: [{ at: now, description: "Departed origin" }],
      deliveredAt: null,
    });
    expect(await adapter.getTrackingInfo(order.externalOrderId)).toMatchObject({ status: "in_transit" });
  });

  it("follows supplier-side status changes", async () => {
    const order = await adapter.createSupplierOrder(orderInput());
    adapter.setOrderStatus(order.externalOrderId, "paid");
    expect(await adapter.getSupplierOrder(order.externalOrderId)).toMatchObject({
      status: "paid",
      needsPayment: false,
    });
  });

  it("throws typed not-found errors", async () => {
    await expect(adapter.getProduct("missing", "IL")).rejects.toBeInstanceOf(SupplierNotFoundError);
    await expect(adapter.checkStock("p1", "missing", 1)).rejects.toBeInstanceOf(SupplierNotFoundError);
    await expect(adapter.getTrackingInfo("missing")).rejects.toBeInstanceOf(SupplierNotFoundError);
  });
});
