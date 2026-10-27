import { InvalidPricingInputError } from "./errors";

/**
 * Deterministic retail pricing. Pure functions only: no I/O, no clock, no randomness.
 *
 * Money is always an integer in minor units. Supplier costs are USD cents; retail prices are
 * ILS agorot, VAT included (Israeli consumer prices must be shown VAT-inclusive).
 *
 * The model, for a VAT-inclusive retail price P:
 *
 *   landed      = ceil((supplierCost + shipping) × fx × (1 + fxBuffer))
 *   netRevenue  = P / (1 + vat)                     revenue after VAT is remitted
 *   paymentFee  = P × feeRate + feeFixed            the processor charges on the gross amount
 *   profit      = netRevenue − paymentFee − landed
 *   margin      = profit / netRevenue
 *
 * The target price is the P at which profit = landed × markup, i.e. the price that recovers
 * landed cost, the markup, the payment fee and VAT:
 *
 *   P_target = (landed × (1 + markup) + feeFixed) / (1/(1+vat) − feeRate)
 *
 * The positioning tier multiplies P_target; the result is rounded up for display, and finally
 * checked against the hard floors (minimum absolute profit, minimum margin) and optional
 * ceiling. A price that breaks a hard limit is rejected — never silently adjusted — so a human
 * decides whether to change the tier, the policy, or the product.
 */

export const PRICING_TIERS = ["budget", "standard", "premium"] as const;
export type PricingTier = (typeof PRICING_TIERS)[number];

export type CostInputs = {
  /** Supplier unit cost, USD cents. Must be > 0. */
  supplierCostUsdMinor: number;
  /** Shipping to the customer's country, USD cents. 0 for free shipping. */
  shippingCostUsdMinor: number;
};

export type MarketParameters = {
  /** ILS per 1 USD. */
  fxUsdToIls: number;
  /** Safety buffer on the FX rate for conversion fees and rate movement, e.g. 0.03. */
  fxBuffer: number;
  /** VAT rate as a fraction, e.g. 0.18. */
  vatRate: number;
  /** Percentage processor fee as a fraction of the gross charge, e.g. 0.029. */
  paymentFeeRate: number;
  /** Fixed processor fee per charge, ILS agorot. */
  paymentFeeFixedMinor: number;
};

export type PricingPolicy = {
  /** Desired profit as a fraction of landed cost, e.g. 0.6 for a 60% markup. */
  markupRate: number;
  /** Hard floor: profit in ILS agorot. */
  minProfitMinor: number;
  /** Hard floor: profit as a fraction of net revenue (after VAT), e.g. 0.2. */
  minMarginRate: number;
  tierMultipliers: Readonly<Record<PricingTier, number>>;
  /** Optional hard ceiling, ILS agorot, VAT included. */
  maxPriceMinor?: number;
  /** "charm" rounds up to the next price ending in 9.90 (₪49.90, ₪129.90). */
  rounding: "charm" | "none";
};

export type PriceBreakdown = {
  priceMinor: number;
  vatMinor: number;
  netRevenueMinor: number;
  paymentFeeMinor: number;
  landedCostMinor: number;
  profitMinor: number;
  /** profit / netRevenue */
  marginRate: number;
  /** profit / landedCost */
  markupRate: number;
};

export type PriceViolation = "below_min_profit" | "below_min_margin" | "exceeds_max_price";

export type PricingResult =
  | {
      ok: true;
      priceMinor: number;
      tier: PricingTier;
      breakdown: PriceBreakdown;
      /** Lowest price that satisfies both hard floors (before rounding). */
      minimumPriceMinor: number;
    }
  | {
      ok: false;
      /** The price that was computed and rejected. */
      priceMinor: number;
      tier: PricingTier;
      violations: readonly PriceViolation[];
      breakdown: PriceBreakdown;
      minimumPriceMinor: number;
    };

export type PricingInput = {
  cost: CostInputs;
  market: MarketParameters;
  policy: PricingPolicy;
  tier: PricingTier;
};

/** Float products like 4573.2000000001 must not round up an extra agora. */
const EPSILON = 1e-7;
const ceilMinor = (x: number) => Math.ceil(x - EPSILON);

export function computeRetailPrice(input: PricingInput): PricingResult {
  const { cost, market, policy, tier } = input;
  validateCost(cost);
  validateMarket(market);
  validatePolicy(policy);
  if (!PRICING_TIERS.includes(tier))
    throw new InvalidPricingInputError("tier", `is not one of ${PRICING_TIERS.join(", ")}`);

  const landed = landedCostMinor(cost, market);
  const target = (landed * (1 + policy.markupRate) + market.paymentFeeFixedMinor) / netFactor(market);
  const tiered = ceilMinor(target * policy.tierMultipliers[tier]);
  const priceMinor = policy.rounding === "charm" ? charmRound(tiered) : tiered;

  const breakdown = analyzePrice(priceMinor, landed, market);
  const violations = findViolations(breakdown, policy);
  const minimumPriceMinor = minimumViablePrice(landed, market, policy);

  return violations.length === 0
    ? { ok: true, priceMinor, tier, breakdown, minimumPriceMinor }
    : { ok: false, priceMinor, tier, violations, breakdown, minimumPriceMinor };
}

/** Landed cost in ILS agorot, rounded up so it is never understated. */
export function landedCostMinor(cost: CostInputs, market: MarketParameters): number {
  validateCost(cost);
  validateMarket(market);
  return ceilMinor(
    (cost.supplierCostUsdMinor + cost.shippingCostUsdMinor) * market.fxUsdToIls * (1 + market.fxBuffer),
  );
}

/**
 * Full economics of selling at `priceMinor`. Used for computed prices and for validating a
 * price someone typed by hand. Amounts are rounded to whole agorot the way they will be booked.
 */
export function analyzePrice(
  priceMinor: number,
  landedMinor: number,
  market: MarketParameters,
): PriceBreakdown {
  assertMinorAmount("priceMinor", priceMinor, { positive: true });
  assertMinorAmount("landedMinor", landedMinor, { positive: true });
  validateMarket(market);

  const netRevenueMinor = Math.round(priceMinor / (1 + market.vatRate));
  const vatMinor = priceMinor - netRevenueMinor;
  const paymentFeeMinor = Math.round(priceMinor * market.paymentFeeRate) + market.paymentFeeFixedMinor;
  const profitMinor = netRevenueMinor - paymentFeeMinor - landedMinor;
  return {
    priceMinor,
    vatMinor,
    netRevenueMinor,
    paymentFeeMinor,
    landedCostMinor: landedMinor,
    profitMinor,
    marginRate: netRevenueMinor > 0 ? profitMinor / netRevenueMinor : 0,
    markupRate: profitMinor / landedMinor,
  };
}

export function findViolations(breakdown: PriceBreakdown, policy: PricingPolicy): PriceViolation[] {
  const violations: PriceViolation[] = [];
  if (breakdown.profitMinor < policy.minProfitMinor) violations.push("below_min_profit");
  if (breakdown.marginRate < policy.minMarginRate) violations.push("below_min_margin");
  if (policy.maxPriceMinor !== undefined && breakdown.priceMinor > policy.maxPriceMinor) {
    violations.push("exceeds_max_price");
  }
  return violations;
}

/**
 * The smallest integer price satisfying both hard floors. Solved in closed form, then nudged
 * up by whole agorot to absorb the per-line rounding in `analyzePrice`.
 *
 *   margin floor:  P ≥ (feeFixed + landed) / ((1 − minMargin)/(1+vat) − feeRate)
 *   profit floor:  P ≥ (feeFixed + landed + minProfit) / (1/(1+vat) − feeRate)
 */
export function minimumViablePrice(
  landedMinor: number,
  market: MarketParameters,
  policy: PricingPolicy,
): number {
  assertMinorAmount("landedMinor", landedMinor, { positive: true });
  validateMarket(market);
  validatePolicy(policy);
  const k = 1 / (1 + market.vatRate);
  const marginDenominator = k * (1 - policy.minMarginRate) - market.paymentFeeRate;
  if (marginDenominator <= 0) {
    throw new InvalidPricingInputError(
      "policy.minMarginRate",
      "is unreachable: VAT and payment fees consume all revenue at this margin",
    );
  }
  const byMargin = (market.paymentFeeFixedMinor + landedMinor) / marginDenominator;
  const byProfit = (market.paymentFeeFixedMinor + landedMinor + policy.minProfitMinor) / netFactor(market);

  let price = Math.max(1, ceilMinor(Math.max(byMargin, byProfit)));
  const floorsOnly = { ...policy, maxPriceMinor: undefined };
  const meetsFloors = (p: number) =>
    findViolations(analyzePrice(p, landedMinor, market), floorsOnly).length === 0;
  // Per-line rounding in analyzePrice can move the true integer minimum a few agorot either way.
  for (let i = 0; i < 100 && !meetsFloors(price); i++) price += 1;
  for (let i = 0; i < 100 && price > 1 && meetsFloors(price - 1); i++) price -= 1;
  return price;
}

/** Rounds up to the next price ending in 9.90: 4523 → 4990, 4990 → 4990, 4991 → 5990. */
export function charmRound(priceMinor: number): number {
  assertMinorAmount("priceMinor", priceMinor, { positive: true });
  return Math.ceil((priceMinor + 10) / 1000) * 1000 - 10;
}

/** Share of the gross price left after VAT and the percentage fee. */
function netFactor(market: MarketParameters): number {
  const factor = 1 / (1 + market.vatRate) - market.paymentFeeRate;
  if (factor <= 0) {
    throw new InvalidPricingInputError("market.paymentFeeRate", "consumes all revenue after VAT");
  }
  return factor;
}

// ---------------------------------------------------------------------------------------------
// Validation. Inputs come from supplier APIs, config rows and admins — never trust them.
// ---------------------------------------------------------------------------------------------

function assertFinite(field: string, value: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidPricingInputError(field, "must be a finite number");
  }
}

function assertMinorAmount(field: string, value: number, opts: { positive: boolean }) {
  assertFinite(field, value);
  if (!Number.isSafeInteger(value))
    throw new InvalidPricingInputError(field, "must be an integer amount in minor units");
  if (opts.positive ? value <= 0 : value < 0) {
    throw new InvalidPricingInputError(
      field,
      opts.positive ? "must be greater than 0" : "must not be negative",
    );
  }
}

function assertRate(field: string, value: number, min: number, maxExclusive: number) {
  assertFinite(field, value);
  if (value < min || value >= maxExclusive) {
    throw new InvalidPricingInputError(field, `must be in [${min}, ${maxExclusive})`);
  }
}

function validateCost(cost: CostInputs) {
  assertMinorAmount("cost.supplierCostUsdMinor", cost.supplierCostUsdMinor, { positive: true });
  assertMinorAmount("cost.shippingCostUsdMinor", cost.shippingCostUsdMinor, { positive: false });
}

function validateMarket(market: MarketParameters) {
  assertFinite("market.fxUsdToIls", market.fxUsdToIls);
  if (market.fxUsdToIls <= 0)
    throw new InvalidPricingInputError("market.fxUsdToIls", "must be greater than 0");
  assertRate("market.fxBuffer", market.fxBuffer, 0, 1);
  assertRate("market.vatRate", market.vatRate, 0, 1);
  assertRate("market.paymentFeeRate", market.paymentFeeRate, 0, 1);
  assertMinorAmount("market.paymentFeeFixedMinor", market.paymentFeeFixedMinor, { positive: false });
}

function validatePolicy(policy: PricingPolicy) {
  assertFinite("policy.markupRate", policy.markupRate);
  if (policy.markupRate < 0) throw new InvalidPricingInputError("policy.markupRate", "must not be negative");
  assertMinorAmount("policy.minProfitMinor", policy.minProfitMinor, { positive: false });
  assertRate("policy.minMarginRate", policy.minMarginRate, 0, 1);
  for (const tier of PRICING_TIERS) {
    const multiplier = policy.tierMultipliers[tier];
    assertFinite(`policy.tierMultipliers.${tier}`, multiplier);
    if (multiplier <= 0)
      throw new InvalidPricingInputError(`policy.tierMultipliers.${tier}`, "must be greater than 0");
  }
  if (policy.maxPriceMinor !== undefined) {
    assertMinorAmount("policy.maxPriceMinor", policy.maxPriceMinor, { positive: true });
  }
  if (policy.rounding !== "charm" && policy.rounding !== "none") {
    throw new InvalidPricingInputError("policy.rounding", 'must be "charm" or "none"');
  }
}
