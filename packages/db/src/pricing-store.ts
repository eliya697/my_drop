import type { PricingPolicy, PricingTier, PriceViolation } from "@dropship/core";
import { and, eq, inArray } from "drizzle-orm";
import { pricingRules, products, productVariants } from "./schema/catalog";
import type { Executor } from "./transitions";

export type PricingContext = {
  productId: string;
  category: string | null;
  tier: PricingTier;
  ruleId: string;
  ruleScope: string;
  policy: Omit<PricingPolicy, "rounding">;
  variants: { id: string; supplierCostMinor: number; supplierCurrency: string; shippingCostMinor: number }[];
};

/**
 * Loads the product, its active variants, and the most specific active pricing rule:
 * `product:<id>` beats `category:<name>` beats `global`.
 */
export async function loadPricingContext(db: Executor, productId: string): Promise<PricingContext | null> {
  const [product] = await db
    .select({ id: products.id, category: products.category, positioning: products.positioning })
    .from(products)
    .where(eq(products.id, productId));
  if (!product) return null;

  const scopes = [
    `product:${productId}`,
    ...(product.category ? [`category:${product.category}`] : []),
    "global",
  ];
  const rules = await db
    .select()
    .from(pricingRules)
    .where(and(eq(pricingRules.isActive, true), inArray(pricingRules.scope, scopes)));
  const rule = scopes.map((s) => rules.find((r) => r.scope === s)).find(Boolean);
  if (!rule) throw new Error("no active pricing rule (expected at least one with scope 'global')");

  const variants = await db
    .select({
      id: productVariants.id,
      supplierCostMinor: productVariants.supplierCostMinor,
      supplierCurrency: productVariants.supplierCurrency,
      shippingCostMinor: productVariants.shippingCostMinor,
    })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), eq(productVariants.isActive, true)));

  return {
    productId,
    category: product.category,
    tier: product.positioning ?? "standard",
    ruleId: rule.id,
    ruleScope: rule.scope,
    policy: {
      markupRate: Number(rule.markupPct) / 100,
      minMarginRate: Number(rule.targetMarginPct) / 100,
      minProfitMinor: rule.minProfitMinor,
      tierMultipliers: rule.positioningMult,
      ...(rule.maxPriceMinor !== null ? { maxPriceMinor: rule.maxPriceMinor } : {}),
    },
    variants,
  };
}

export type VariantPriceUpdate = {
  variantId: string;
  /** null when the computed price was rejected by a hard limit. */
  priceMinor: number | null;
  calc: {
    ok: boolean;
    computedPriceMinor: number;
    minimumPriceMinor: number;
    violations: readonly PriceViolation[];
    tier: PricingTier;
    ruleId: string;
    ruleScope: string;
    fxUsdToIls: number;
    breakdown: unknown;
    computedAt: string;
  };
};

/** Writes prices and their audit breakdown for a product's variants in one transaction. */
export async function saveVariantPrices(db: Executor, updates: readonly VariantPriceUpdate[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const u of updates) {
      await tx
        .update(productVariants)
        .set({ priceMinor: u.priceMinor, compareAtMinor: null, priceCalc: u.calc })
        .where(eq(productVariants.id, u.variantId));
    }
  });
}
