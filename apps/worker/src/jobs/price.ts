import {
  computeRetailPrice,
  EntityNotFoundError,
  InvalidPricingInputError,
  type MarketParameters,
} from "@dropship/core";
import {
  auditLog,
  loadPricingContext,
  saveVariantPrices,
  type Executor,
  type VariantPriceUpdate,
} from "@dropship/db";
import { z } from "zod";
import type { JobContext } from "../queue/run";

export const priceComputeSchema = z.object({ productId: z.string().uuid() });
export type PriceComputeData = z.infer<typeof priceComputeSchema>;

export type PriceComputeDeps = {
  db: Executor;
  /** null when the exchange rate is not configured (development): pricing is skipped. */
  market: MarketParameters | null;
  now?: () => Date;
};

export type PriceComputeResult =
  { priced: number; rejected: number; tier: string; ruleScope: string } | { skipped: string };

/**
 * price.compute: prices every active variant of a product with the deterministic engine in
 * @dropship/core. The model's positioning only selects the tier multiplier; the hard floors
 * (minimum profit and margin) and the ceiling come from the pricing rule. A price that breaks
 * a floor is stored as null with the reason, so the variant cannot be sold until a human acts.
 */
export function createPriceComputeHandler(deps: PriceComputeDeps) {
  const now = deps.now ?? (() => new Date());

  return async (data: PriceComputeData, ctx: Pick<JobContext, "logger">): Promise<PriceComputeResult> => {
    if (!deps.market) {
      ctx.logger.warn("PRICING_USD_ILS_RATE is not set; skipping pricing");
      return { skipped: "exchange rate not configured" };
    }
    const pricing = await loadPricingContext(deps.db, data.productId);
    if (!pricing) throw new EntityNotFoundError("product", data.productId);

    const computedAt = now().toISOString();
    const updates: VariantPriceUpdate[] = [];
    for (const v of pricing.variants) {
      if (v.supplierCurrency !== "USD") {
        ctx.logger.error({ variantId: v.id, currency: v.supplierCurrency }, "unsupported supplier currency");
        continue;
      }
      try {
        const r = computeRetailPrice({
          cost: { supplierCostUsdMinor: v.supplierCostMinor, shippingCostUsdMinor: v.shippingCostMinor },
          market: deps.market,
          policy: { ...pricing.policy, rounding: "charm" },
          tier: pricing.tier,
        });
        updates.push({
          variantId: v.id,
          priceMinor: r.ok ? r.priceMinor : null,
          calc: {
            ok: r.ok,
            computedPriceMinor: r.priceMinor,
            minimumPriceMinor: r.minimumPriceMinor,
            violations: r.ok ? [] : r.violations,
            tier: r.tier,
            ruleId: pricing.ruleId,
            ruleScope: pricing.ruleScope,
            fxUsdToIls: deps.market.fxUsdToIls,
            breakdown: r.breakdown,
            computedAt,
          },
        });
      } catch (err) {
        // Bad supplier data (e.g. a zero cost) must not price the variant — but must not block the rest.
        if (!(err instanceof InvalidPricingInputError)) throw err;
        ctx.logger.error(
          { variantId: v.id, field: err.field, reason: err.reason },
          "variant cannot be priced",
        );
        updates.push({
          variantId: v.id,
          priceMinor: null,
          calc: {
            ok: false,
            computedPriceMinor: 0,
            minimumPriceMinor: 0,
            violations: [],
            tier: pricing.tier,
            ruleId: pricing.ruleId,
            ruleScope: pricing.ruleScope,
            fxUsdToIls: deps.market.fxUsdToIls,
            breakdown: { error: `${err.field} ${err.reason}` },
            computedAt,
          },
        });
      }
    }

    await saveVariantPrices(deps.db, updates);
    const priced = updates.filter((u) => u.priceMinor !== null).length;
    await deps.db.insert(auditLog).values({
      actorType: "system",
      entityType: "product",
      entityId: data.productId,
      action: "product.priced",
      data: {
        priced,
        rejected: updates.length - priced,
        tier: pricing.tier,
        ruleScope: pricing.ruleScope,
        fx: deps.market.fxUsdToIls,
      },
    });
    return { priced, rejected: updates.length - priced, tier: pricing.tier, ruleScope: pricing.ruleScope };
  };
}
