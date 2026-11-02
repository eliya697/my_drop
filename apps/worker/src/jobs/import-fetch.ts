import {
  ConcurrentModificationError,
  NoEligibleVariantError,
  selectLowestPriceVariant,
  SupplierRejectedError,
  type CountryCode,
  type SupplierCatalog,
} from "@dropship/core";
import { ConcurrencyLimiter } from "@dropship/adapters";
import {
  transitionProduct,
  upsertImportedProduct,
  type Executor,
  type ImportedVariant,
  type ImportResult,
} from "@dropship/db";
import { z } from "zod";
import type { JobContext } from "../queue/run";

export const IMPORT_FETCH_QUEUE = "import.fetch" as const;
export const IMPORT_MEDIA_QUEUE = "import.media" as const;

export const importFetchSchema = z.object({
  externalProductId: z.string().regex(/^\d{8,20}$/),
  sourceUrl: z.string().url().max(2000).optional(),
  /** Profile id of the admin who requested the import, for the audit log. */
  requestedBy: z.string().max(100).optional(),
});
export type ImportFetchData = z.infer<typeof importFetchSchema>;

export type ImportFetchDeps = {
  db: Executor;
  catalog: SupplierCatalog;
  shipTo: CountryCode;
  maxShippingDays: number;
  /** Parallel freight quotes per product (the client's own rate limit still applies). */
  quoteConcurrency?: number;
  /** Queue real-time AI enrichment for products still in `imported` (AI_ENRICH_MODE=realtime). */
  autoEnrich?: boolean;
};

/**
 * import.fetch: pulls a product from the supplier, picks the cheapest tracked shipping option
 * within the delivery limit for every in-stock SKU, persists it all atomically, and queues
 * image processing. Safe to re-run: snapshots, variants and images are upserted.
 */
export function createImportFetchHandler(deps: ImportFetchDeps) {
  const limiter = new ConcurrencyLimiter(deps.quoteConcurrency ?? 3);

  return async (
    data: ImportFetchData,
    ctx: Pick<JobContext, "enqueue" | "logger">,
  ): Promise<ImportResult> => {
    const product = await deps.catalog.getProduct(data.externalProductId, deps.shipTo);
    if (!product.available) {
      throw new SupplierRejectedError(deps.catalog.name, "PRODUCT_UNAVAILABLE", "product is not on sale");
    }

    const variants: ImportedVariant[] = await Promise.all(
      product.variants.map(async (variant): Promise<ImportedVariant> => {
        if (variant.stock <= 0) return { skuId: variant.skuId, shipping: null };
        const quotes = await limiter.run(() =>
          deps.catalog.quoteShipping({
            externalProductId: product.externalId,
            skuId: variant.skuId,
            quantity: 1,
            shipTo: deps.shipTo,
          }),
        );
        try {
          const best = selectLowestPriceVariant(deps.catalog.name, [variant], quotes, {
            quantity: 1,
            requireTracking: true,
            maxShippingDays: deps.maxShippingDays,
          });
          return { skuId: variant.skuId, shipping: best.shipping };
        } catch (err) {
          if (err instanceof NoEligibleVariantError) return { skuId: variant.skuId, shipping: null };
          throw err;
        }
      }),
    );

    const result = await upsertImportedProduct(deps.db, {
      product,
      variants,
      ...(data.sourceUrl ? { sourceUrl: data.sourceUrl } : {}),
      actor: data.requestedBy ? { type: "user", id: data.requestedBy } : { type: "system" },
    });

    if (result.activeVariants === 0) {
      ctx.logger.warn(
        { productId: result.productId, maxShippingDays: deps.maxShippingDays },
        "imported product has no sellable variant (stock or tracked shipping)",
      );
    }
    if (result.pendingImages > 0) {
      // No dedupe: import.media only processes images that are still pending, so an extra
      // job is harmless, while a deduplicated one could leave newly added images unprocessed.
      await ctx.enqueue(IMPORT_MEDIA_QUEUE, { productId: result.productId });
    }
    if (deps.autoEnrich && result.activeVariants > 0) {
      try {
        await transitionProduct(deps.db, {
          id: result.productId,
          from: "imported",
          to: "enriching",
          actor: { type: "system" },
        });
        await ctx.enqueue("enrich.listing", { productId: result.productId });
      } catch (err) {
        // Already past `imported` (a re-sync of an enriched product): nothing to do.
        if (!(err instanceof ConcurrentModificationError)) throw err;
      }
    }
    return result;
  };
}
