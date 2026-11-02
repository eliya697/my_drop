import { randomUUID } from "node:crypto";
import type { ShippingQuote, SupplierProduct } from "@dropship/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stableHash, upsertImportedProduct } from "./catalog-import";
import { createDb, type DbHandle } from "./client";
import { runMigrations } from "./migrate";
import { auditLog, productImages, products, productVariants, supplierProducts } from "./schema/index";
import { transitionProduct } from "./transitions";

const url = process.env.TEST_DATABASE_URL;

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
const quote = (skuId: string, cents = 199): ShippingQuote => ({
  skuId,
  method: "CAINIAO_FULFILLMENT_STD",
  carrier: "AliExpress Selection Standard",
  cost: usd(cents),
  daysMin: 10,
  daysMax: 20,
  tracked: true,
});

function product(externalId: string, overrides: Partial<SupplierProduct> = {}): SupplierProduct {
  return {
    supplier: "aliexpress",
    externalId,
    title: "Polarized Sunglasses",
    descriptionRaw: "<p>x</p>",
    images: ["https://ae01.alicdn.com/kf/main.jpg", "https://ae01.alicdn.com/kf/side.jpg"],
    attributes: {},
    variants: [
      {
        skuId: "black",
        options: { Color: "Black" },
        unitCost: usd(394),
        stock: 57,
        imageUrl: "https://ae01.alicdn.com/kf/black.jpg",
      },
      { skuId: "green", options: { Color: "Green" }, unitCost: usd(410), stock: 0 },
    ],
    sellerId: "store-1",
    available: true,
    raw: { externalId, version: 1 },
    ...overrides,
  };
}

describe("stableHash", () => {
  it("ignores key order but not values", () => {
    expect(stableHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(stableHash({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    expect(stableHash({ a: [1, 2] })).not.toBe(stableHash({ a: [2, 1] }));
  });
});

describe.skipIf(!url)("upsertImportedProduct (integration)", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!, { max: 4 });
  });
  afterAll(async () => {
    await handle?.close();
  });

  const variantsOf = (productId: string) =>
    handle.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, productId))
      .orderBy(productVariants.externalSkuId);

  it("creates snapshot, product, variants, images and an audit entry", async () => {
    const id = `ext-${randomUUID()}`;
    const result = await upsertImportedProduct(handle.db, {
      product: product(id),
      variants: [
        { skuId: "black", shipping: quote("black") },
        { skuId: "green", shipping: null },
      ],
      sourceUrl: `https://www.aliexpress.com/item/${id}.html`,
      actor: { type: "user", id: "admin-1" },
    });

    expect(result).toMatchObject({
      created: true,
      snapshotChanged: true,
      activeVariants: 1,
      inactiveVariants: 1,
      pendingImages: 3,
    });

    const [p] = await handle.db.select().from(products).where(eq(products.id, result.productId));
    expect(p).toMatchObject({
      status: "imported",
      externalId: id,
      latestSnapshotId: result.snapshotId,
      title: "Polarized Sunglasses",
    });

    const variants = await variantsOf(result.productId);
    expect(variants.map((v) => [v.externalSkuId, v.isActive, v.shippingCostMinor, v.shippingMethod])).toEqual(
      [
        ["black", true, 199, "CAINIAO_FULFILLMENT_STD"],
        ["green", false, 0, null],
      ],
    );
    expect(variants[0]).toMatchObject({
      supplierCostMinor: 394,
      supplierCurrency: "USD",
      stock: 57,
      shippingDaysMax: 20,
      priceMinor: null,
    });

    const images = await handle.db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, result.productId))
      .orderBy(productImages.position);
    expect(images.map((i) => i.sourceUrl)).toEqual([
      "https://ae01.alicdn.com/kf/main.jpg",
      "https://ae01.alicdn.com/kf/side.jpg",
      "https://ae01.alicdn.com/kf/black.jpg",
    ]);
    expect(images[2]!.variantId).toBe(variants[0]!.id);

    const audit = await handle.db.select().from(auditLog).where(eq(auditLog.entityId, result.productId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "product.imported", actorType: "user", actorId: "admin-1" });
  });

  it("is idempotent: re-importing the same payload changes nothing", async () => {
    const id = `ext-${randomUUID()}`;
    const input = {
      product: product(id),
      variants: [{ skuId: "black", shipping: quote("black") }],
      actor: { type: "system" as const },
    };
    const first = await upsertImportedProduct(handle.db, input);
    const second = await upsertImportedProduct(handle.db, input);

    expect(second).toMatchObject({
      productId: first.productId,
      created: false,
      snapshotChanged: false,
      snapshotId: first.snapshotId,
    });
    const snapshots = await handle.db
      .select()
      .from(supplierProducts)
      .where(eq(supplierProducts.externalId, id));
    expect(snapshots).toHaveLength(1);
    expect(await variantsOf(first.productId)).toHaveLength(2);
    const images = await handle.db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, first.productId));
    expect(images).toHaveLength(3);
  });

  it("re-sync updates costs and stock, deactivates vanished SKUs, and never touches status or copy", async () => {
    const id = `ext-${randomUUID()}`;
    const first = await upsertImportedProduct(handle.db, {
      product: product(id),
      variants: [{ skuId: "black", shipping: quote("black") }],
      actor: { type: "system" },
    });
    // Simulate the later pipeline: AI copy + review.
    await transitionProduct(handle.db, {
      id: first.productId,
      from: "imported",
      to: "enriching",
      actor: { type: "system" },
    });
    await transitionProduct(handle.db, {
      id: first.productId,
      from: "enriching",
      to: "pending_review",
      actor: { type: "ai" },
      patch: { title: "משקפי שמש מקוטבים" },
    });

    const changed = product(id, {
      raw: { externalId: id, version: 2 },
      variants: [{ skuId: "black", options: { Color: "Black" }, unitCost: usd(450), stock: 12 }],
    });
    const second = await upsertImportedProduct(handle.db, {
      product: changed,
      variants: [{ skuId: "black", shipping: quote("black", 250) }],
      actor: { type: "system" },
    });

    expect(second).toMatchObject({ created: false, snapshotChanged: true });
    expect(second.snapshotId).not.toBe(first.snapshotId);

    const [p] = await handle.db.select().from(products).where(eq(products.id, first.productId));
    expect(p).toMatchObject({
      status: "pending_review",
      title: "משקפי שמש מקוטבים",
      latestSnapshotId: second.snapshotId,
    });

    const variants = await variantsOf(first.productId);
    expect(variants.find((v) => v.externalSkuId === "black")).toMatchObject({
      supplierCostMinor: 450,
      stock: 12,
      shippingCostMinor: 250,
      isActive: true,
    });
    expect(variants.find((v) => v.externalSkuId === "green")).toMatchObject({ isActive: false, stock: 0 });

    const audit = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, first.productId), eq(auditLog.action, "product.resynced")));
    expect(audit).toHaveLength(1);
  });

  it("does not re-queue images that were already processed or rejected", async () => {
    const id = `ext-${randomUUID()}`;
    const input = {
      product: product(id),
      variants: [{ skuId: "black", shipping: quote("black") }],
      actor: { type: "system" as const },
    };
    const first = await upsertImportedProduct(handle.db, input);
    const images = await handle.db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, first.productId));
    await handle.db
      .update(productImages)
      .set({ storageKey: "products/x/a.webp" })
      .where(eq(productImages.id, images[0]!.id));
    await handle.db
      .update(productImages)
      .set({ failedReason: "too small" })
      .where(eq(productImages.id, images[1]!.id));

    expect((await upsertImportedProduct(handle.db, input)).pendingImages).toBe(1);
  });
});
