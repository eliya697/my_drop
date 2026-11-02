import { createHash } from "node:crypto";
import type { ShippingQuote, SupplierProduct } from "@dropship/core";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { productImages, products, productVariants, supplierProducts } from "./schema/catalog";
import type { Actor, Executor } from "./transitions";
import { auditLog } from "./schema/integration";

export type ImportedVariant = {
  skuId: string;
  /** The shipping option chosen for this SKU, or null when nothing eligible ships. */
  shipping: ShippingQuote | null;
};

export type ImportResult = {
  productId: string;
  created: boolean;
  snapshotId: string;
  /** False when the supplier payload was byte-identical to the latest snapshot. */
  snapshotChanged: boolean;
  activeVariants: number;
  inactiveVariants: number;
  pendingImages: number;
};

/** The supplier-neutral view stored next to the raw payload (everything except `raw`). */
export function normalizedOf(product: SupplierProduct): Omit<SupplierProduct, "raw"> {
  const { raw: _raw, ...rest } = product;
  return rest;
}

/** Stable JSON (sorted keys) so the same payload always hashes the same. */
export function stableHash(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/**
 * Persists one supplier product, atomically and idempotently:
 *
 *  - an immutable `supplier_products` snapshot (deduplicated by payload hash);
 *  - the `products` row: created in `imported` status, or — if it already exists — only its
 *    snapshot pointer moves. Status and AI-written copy are never touched by a re-import;
 *  - one `product_variants` row per SKU (upsert). A SKU is active only if it has stock and an
 *    eligible shipping option; SKUs that disappeared from the supplier are deactivated;
 *  - `product_images` for every new image URL (existing rows keep their processed media).
 *
 * Retail prices are not set here; pricing runs as its own step.
 */
export async function upsertImportedProduct(
  executor: Executor,
  input: { product: SupplierProduct; variants: readonly ImportedVariant[]; sourceUrl?: string; actor: Actor },
): Promise<ImportResult> {
  const { product } = input;
  const shippingBySku = new Map(input.variants.map((v) => [v.skuId, v.shipping]));
  const rawHash = stableHash(product.raw);

  return executor.transaction(async (tx) => {
    const inserted = await tx
      .insert(supplierProducts)
      .values({
        supplier: product.supplier,
        externalId: product.externalId,
        sourceUrl: input.sourceUrl ?? null,
        raw: product.raw,
        normalized: normalizedOf(product),
        rawHash,
      })
      .onConflictDoNothing()
      .returning({ id: supplierProducts.id });
    const snapshotChanged = inserted.length > 0;
    const snapshotId =
      inserted[0]?.id ??
      (
        await tx
          .select({ id: supplierProducts.id })
          .from(supplierProducts)
          .where(
            and(
              eq(supplierProducts.supplier, product.supplier),
              eq(supplierProducts.externalId, product.externalId),
              eq(supplierProducts.rawHash, rawHash),
            ),
          )
      )[0]!.id;

    // xmax = 0 identifies a freshly inserted row (vs. one updated by ON CONFLICT).
    const [row] = await tx
      .insert(products)
      .values({
        supplier: product.supplier,
        externalId: product.externalId,
        latestSnapshotId: snapshotId,
        title: product.title,
      })
      .onConflictDoUpdate({
        target: [products.supplier, products.externalId],
        set: { latestSnapshotId: snapshotId },
      })
      .returning({ id: products.id, created: sql<boolean>`(xmax = 0)` });
    const productId = row!.id;

    let active = 0;
    for (const variant of product.variants) {
      const shipping = shippingBySku.get(variant.skuId) ?? null;
      const isActive = product.available && variant.stock > 0 && shipping !== null;
      if (isActive) active++;
      const values = {
        options: { ...variant.options },
        supplierCostMinor: variant.unitCost.amountMinor,
        supplierCurrency: variant.unitCost.currency,
        shippingCostMinor: shipping?.cost.amountMinor ?? 0,
        shippingMethod: shipping?.method ?? null,
        shippingDaysMin: shipping?.daysMin ?? null,
        shippingDaysMax: shipping?.daysMax ?? null,
        stock: variant.stock,
        isActive,
      };
      await tx
        .insert(productVariants)
        .values({ productId, externalSkuId: variant.skuId, ...values })
        .onConflictDoUpdate({
          target: [productVariants.productId, productVariants.externalSkuId],
          set: values,
        });
    }

    const liveSkus = product.variants.map((v) => v.skuId);
    const removed = await tx
      .update(productVariants)
      .set({ isActive: false, stock: 0 })
      .where(
        and(eq(productVariants.productId, productId), notInArray(productVariants.externalSkuId, liveSkus)),
      )
      .returning({ id: productVariants.id });

    const imageUrls = [
      ...product.images,
      ...product.variants.flatMap((v) => (v.imageUrl ? [v.imageUrl] : [])),
    ];
    const uniqueUrls = [...new Set(imageUrls)];
    if (uniqueUrls.length > 0) {
      await tx
        .insert(productImages)
        .values(uniqueUrls.map((sourceUrl, position) => ({ productId, sourceUrl, position })))
        .onConflictDoNothing({ target: [productImages.productId, productImages.sourceUrl] });

      // Link variant-specific images to their variant.
      for (const variant of product.variants) {
        if (!variant.imageUrl) continue;
        await tx.execute(sql`
          update ${productImages} set variant_id = v.id
          from ${productVariants} v
          where ${productImages.productId} = ${productId}
            and ${productImages.sourceUrl} = ${variant.imageUrl}
            and v.product_id = ${productId} and v.external_sku_id = ${variant.skuId}`);
      }
    }

    const pending = await tx
      .select({ id: productImages.id })
      .from(productImages)
      .where(
        and(
          eq(productImages.productId, productId),
          isNull(productImages.storageKey),
          isNull(productImages.failedReason),
          uniqueUrls.length > 0 ? inArray(productImages.sourceUrl, uniqueUrls) : sql`false`,
        ),
      );

    const result: ImportResult = {
      productId,
      created: row!.created,
      snapshotId,
      snapshotChanged,
      activeVariants: active,
      inactiveVariants: product.variants.length - active + removed.length,
      pendingImages: pending.length,
    };

    await tx.insert(auditLog).values({
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      entityType: "product",
      entityId: productId,
      action: result.created ? "product.imported" : "product.resynced",
      data: {
        supplier: product.supplier,
        externalId: product.externalId,
        snapshotId,
        snapshotChanged,
        activeVariants: result.activeVariants,
        inactiveVariants: result.inactiveVariants,
      },
    });
    return result;
  });
}

export type PendingImage = { id: string; sourceUrl: string };

export async function listPendingImages(executor: Executor, productId: string): Promise<PendingImage[]> {
  return executor
    .select({ id: productImages.id, sourceUrl: productImages.sourceUrl })
    .from(productImages)
    .where(
      and(
        eq(productImages.productId, productId),
        isNull(productImages.storageKey),
        isNull(productImages.failedReason),
      ),
    )
    .orderBy(productImages.position);
}

export async function markImageStored(
  executor: Executor,
  imageId: string,
  stored: { storageKey: string; width: number; height: number },
): Promise<void> {
  await executor
    .update(productImages)
    .set({ ...stored, failedReason: null })
    .where(eq(productImages.id, imageId));
}

export async function markImageFailed(executor: Executor, imageId: string, reason: string): Promise<void> {
  await executor
    .update(productImages)
    .set({ failedReason: reason.slice(0, 500) })
    .where(eq(productImages.id, imageId));
}
