import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidPricingInputError } from "./errors";
import {
  analyzePrice,
  charmRound,
  computeRetailPrice,
  landedCostMinor,
  minimumViablePrice,
  PRICING_TIERS,
  type MarketParameters,
  type PricingInput,
  type PricingPolicy,
} from "./pricing";

const MARKET: MarketParameters = {
  fxUsdToIls: 3.7,
  fxBuffer: 0.03,
  vatRate: 0.18,
  paymentFeeRate: 0.029,
  paymentFeeFixedMinor: 120,
};

const POLICY: PricingPolicy = {
  markupRate: 0.6,
  minProfitMinor: 1500,
  minMarginRate: 0.2,
  tierMultipliers: { budget: 0.9, standard: 1, premium: 1.2 },
  rounding: "charm",
};

const input = (overrides: Partial<PricingInput> = {}): PricingInput => ({
  cost: { supplierCostUsdMinor: 1000, shippingCostUsdMinor: 200 },
  market: MARKET,
  policy: POLICY,
  tier: "standard",
  ...overrides,
});

function expectInvalid(fn: () => unknown, field: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidPricingInputError);
    expect((err as InvalidPricingInputError).field).toBe(field);
    expect((err as InvalidPricingInputError).code).toBe("INVALID_PRICING_INPUT");
    return;
  }
  throw new Error(`expected InvalidPricingInputError for ${field}`);
}

describe("computeRetailPrice — worked example", () => {
  // $10.00 item + $2.00 shipping at ₪3.70/$ with a 3% FX buffer:
  //   landed = ceil(1200 × 3.7 × 1.03) = ceil(4573.2) = 4574 agorot
  //   target = (4574 × 1.6 + 120) / (1/1.18 − 0.029) = 9088.4 → ceil 9089 → charm ₪99.90
  //   net = round(9990 / 1.18) = 8466, VAT = 1524, fee = round(289.71) + 120 = 410
  //   profit = 8466 − 410 − 4574 = 3482 (margin 41.1%)
  it("produces the hand-computed price and breakdown", () => {
    const result = computeRetailPrice(input());
    expect(result.ok).toBe(true);
    expect(result.priceMinor).toBe(9990);
    expect(result.breakdown).toMatchObject({
      priceMinor: 9990,
      landedCostMinor: 4574,
      netRevenueMinor: 8466,
      vatMinor: 1524,
      paymentFeeMinor: 410,
      profitMinor: 3482,
    });
    expect(result.breakdown.marginRate).toBeCloseTo(0.4113, 4);
    expect(result.breakdown.vatMinor + result.breakdown.netRevenueMinor).toBe(result.priceMinor);
  });

  it("hits the target markup exactly when rounding is disabled", () => {
    const result = computeRetailPrice(input({ policy: { ...POLICY, rounding: "none" } }));
    expect(result.ok).toBe(true);
    expect(result.priceMinor).toBe(9089);
    // profit ≈ landed × markup (± one agora of per-line rounding)
    expect(Math.abs(result.breakdown.profitMinor - Math.round(4574 * 0.6))).toBeLessThanOrEqual(1);
  });
});

describe("computeRetailPrice — positioning tiers", () => {
  it("orders prices budget ≤ standard ≤ premium", () => {
    const [budget, standard, premium] = PRICING_TIERS.map(
      (tier) => computeRetailPrice(input({ tier })).priceMinor,
    );
    expect(budget).toBeLessThanOrEqual(standard!);
    expect(standard).toBeLessThanOrEqual(premium!);
    expect(premium).toBeGreaterThan(budget!);
  });

  it("reports the tier it priced", () => {
    expect(computeRetailPrice(input({ tier: "premium" })).tier).toBe("premium");
  });

  it("rejects a budget price that falls under the margin floor instead of clamping it", () => {
    const thin: PricingPolicy = {
      ...POLICY,
      markupRate: 0.25,
      minMarginRate: 0.2,
      minProfitMinor: 0,
      rounding: "none",
    };
    const result = computeRetailPrice(input({ policy: thin, tier: "budget" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toContain("below_min_margin");
    expect(result.breakdown.marginRate).toBeLessThan(0.2);
    expect(result.minimumPriceMinor).toBeGreaterThan(result.priceMinor);
  });

  it("rejects an unknown tier", () => {
    expectInvalid(() => computeRetailPrice(input({ tier: "luxury" as never })), "tier");
  });
});

describe("computeRetailPrice — hard limits", () => {
  it("rejects a cheap item whose profit is below the absolute minimum", () => {
    // $0.50 item: a 60% markup is only a few shekels of profit.
    const result = computeRetailPrice(
      input({
        cost: { supplierCostUsdMinor: 50, shippingCostUsdMinor: 0 },
        policy: { ...POLICY, rounding: "none" },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual(["below_min_profit"]);
    expect(result.breakdown.profitMinor).toBeLessThan(POLICY.minProfitMinor);
  });

  it("reports every violated limit", () => {
    const result = computeRetailPrice(
      input({
        cost: { supplierCostUsdMinor: 100, shippingCostUsdMinor: 0 },
        policy: { ...POLICY, markupRate: 0, rounding: "none", maxPriceMinor: 100 },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.violations].sort()).toEqual([
      "below_min_margin",
      "below_min_profit",
      "exceeds_max_price",
    ]);
  });

  it("rejects prices above the ceiling", () => {
    const result = computeRetailPrice(input({ policy: { ...POLICY, maxPriceMinor: 5000 } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual(["exceeds_max_price"]);
  });

  it("accepts a price exactly at the ceiling", () => {
    const result = computeRetailPrice(input({ policy: { ...POLICY, maxPriceMinor: 9990 } }));
    expect(result.ok).toBe(true);
  });

  it("allows zero thresholds", () => {
    const result = computeRetailPrice(
      input({ policy: { ...POLICY, minProfitMinor: 0, minMarginRate: 0, markupRate: 0.1 } }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("computeRetailPrice — input validation", () => {
  it("rejects zero and negative supplier cost", () => {
    for (const bad of [0, -1, -1000]) {
      expectInvalid(
        () => computeRetailPrice(input({ cost: { supplierCostUsdMinor: bad, shippingCostUsdMinor: 0 } })),
        "cost.supplierCostUsdMinor",
      );
    }
  });

  it("accepts zero shipping and rejects negative shipping", () => {
    expect(
      computeRetailPrice(input({ cost: { supplierCostUsdMinor: 1000, shippingCostUsdMinor: 0 } })).ok,
    ).toBe(true);
    expectInvalid(
      () => computeRetailPrice(input({ cost: { supplierCostUsdMinor: 1000, shippingCostUsdMinor: -1 } })),
      "cost.shippingCostUsdMinor",
    );
  });

  it("rejects fractional, NaN, and infinite money amounts", () => {
    for (const bad of [10.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      expectInvalid(
        () => computeRetailPrice(input({ cost: { supplierCostUsdMinor: bad, shippingCostUsdMinor: 0 } })),
        "cost.supplierCostUsdMinor",
      );
    }
  });

  it.each([
    ["market.fxUsdToIls", { ...MARKET, fxUsdToIls: 0 }],
    ["market.fxUsdToIls", { ...MARKET, fxUsdToIls: -3.7 }],
    ["market.fxBuffer", { ...MARKET, fxBuffer: -0.01 }],
    ["market.vatRate", { ...MARKET, vatRate: 1 }],
    ["market.vatRate", { ...MARKET, vatRate: -0.18 }],
    ["market.paymentFeeRate", { ...MARKET, paymentFeeRate: 1.2 }],
    ["market.paymentFeeFixedMinor", { ...MARKET, paymentFeeFixedMinor: -1 }],
    ["market.paymentFeeFixedMinor", { ...MARKET, paymentFeeFixedMinor: 1.5 }],
  ] as const)("rejects invalid %s", (field, market) => {
    expectInvalid(() => computeRetailPrice(input({ market })), field);
  });

  it("rejects a payment fee that consumes all revenue after VAT", () => {
    expectInvalid(
      () => computeRetailPrice(input({ market: { ...MARKET, paymentFeeRate: 0.9 } })),
      "market.paymentFeeRate",
    );
  });

  it.each([
    ["policy.markupRate", { ...POLICY, markupRate: -0.1 }],
    ["policy.minProfitMinor", { ...POLICY, minProfitMinor: -1 }],
    ["policy.minMarginRate", { ...POLICY, minMarginRate: 1 }],
    ["policy.minMarginRate", { ...POLICY, minMarginRate: -0.1 }],
    [
      "policy.tierMultipliers.budget",
      { ...POLICY, tierMultipliers: { ...POLICY.tierMultipliers, budget: 0 } },
    ],
    ["policy.maxPriceMinor", { ...POLICY, maxPriceMinor: 0 }],
    ["policy.rounding", { ...POLICY, rounding: "up" as never }],
  ] as const)("rejects invalid %s", (field, policy) => {
    expectInvalid(() => computeRetailPrice(input({ policy })), field);
  });

  it("rejects a margin floor that VAT and fees make unreachable", () => {
    expectInvalid(
      () => computeRetailPrice(input({ policy: { ...POLICY, minMarginRate: 0.97 } })),
      "policy.minMarginRate",
    );
  });
});

describe("landedCostMinor", () => {
  it("rounds up and never understates cost", () => {
    expect(landedCostMinor({ supplierCostUsdMinor: 1, shippingCostUsdMinor: 0 }, MARKET)).toBe(4); // 3.811
  });

  it("is not inflated by float noise on exact products", () => {
    const market = { ...MARKET, fxUsdToIls: 3.5, fxBuffer: 0 };
    expect(landedCostMinor({ supplierCostUsdMinor: 200, shippingCostUsdMinor: 0 }, market)).toBe(700);
  });
});

describe("analyzePrice", () => {
  it("splits a price into VAT, fees, cost and profit that add back up", () => {
    const b = analyzePrice(12990, 6000, MARKET);
    expect(b.vatMinor + b.netRevenueMinor).toBe(12990);
    expect(b.netRevenueMinor - b.paymentFeeMinor - b.landedCostMinor).toBe(b.profitMinor);
  });

  it("reports negative profit for a price below cost", () => {
    const b = analyzePrice(1000, 5000, MARKET);
    expect(b.profitMinor).toBeLessThan(0);
    expect(b.marginRate).toBeLessThan(0);
  });

  it("rejects a non-positive price", () => {
    expectInvalid(() => analyzePrice(0, 5000, MARKET), "priceMinor");
  });
});

describe("charmRound", () => {
  it.each([
    [1, 990],
    [990, 990],
    [991, 1990],
    [4523, 4990],
    [4990, 4990],
    [4991, 5990],
    [99_995, 100_990],
  ])("%i → %i", (raw, expected) => {
    expect(charmRound(raw)).toBe(expected);
  });
});

describe("pricing properties", () => {
  const costArb = fc.record({
    supplierCostUsdMinor: fc.integer({ min: 1, max: 500_000 }),
    shippingCostUsdMinor: fc.integer({ min: 0, max: 50_000 }),
  });
  const marketArb = fc.record({
    fxUsdToIls: fc.double({ min: 2.5, max: 5, noNaN: true }),
    fxBuffer: fc.double({ min: 0, max: 0.1, noNaN: true }),
    vatRate: fc.double({ min: 0, max: 0.25, noNaN: true }),
    paymentFeeRate: fc.double({ min: 0, max: 0.06, noNaN: true }),
    paymentFeeFixedMinor: fc.integer({ min: 0, max: 300 }),
  });
  const policyArb = fc.record({
    markupRate: fc.double({ min: 0, max: 3, noNaN: true }),
    minProfitMinor: fc.integer({ min: 0, max: 10_000 }),
    minMarginRate: fc.double({ min: 0, max: 0.6, noNaN: true }),
    tierMultipliers: fc.record({
      budget: fc.double({ min: 0.5, max: 1, noNaN: true }),
      standard: fc.constant(1),
      premium: fc.double({ min: 1, max: 2, noNaN: true }),
    }),
    rounding: fc.constantFrom("charm" as const, "none" as const),
  });
  const tierArb = fc.constantFrom(...PRICING_TIERS);

  it("never accepts a price that breaks a hard floor", () => {
    fc.assert(
      fc.property(costArb, marketArb, policyArb, tierArb, (cost, market, policy, tier) => {
        const result = computeRetailPrice({ cost, market, policy, tier });
        if (!result.ok) return;
        expect(result.breakdown.profitMinor).toBeGreaterThanOrEqual(policy.minProfitMinor);
        expect(result.breakdown.marginRate).toBeGreaterThanOrEqual(policy.minMarginRate);
        expect(result.priceMinor).toBeGreaterThanOrEqual(result.minimumPriceMinor);
      }),
      { numRuns: 2_000 },
    );
  });

  it("finds the exact minimum viable price", () => {
    fc.assert(
      fc.property(costArb, marketArb, policyArb, (cost, market, policy) => {
        const landed = landedCostMinor(cost, market);
        const floor = minimumViablePrice(landed, market, policy);
        const at = analyzePrice(floor, landed, market);
        expect(at.profitMinor).toBeGreaterThanOrEqual(policy.minProfitMinor);
        expect(at.marginRate).toBeGreaterThanOrEqual(policy.minMarginRate);
        if (floor > 1) {
          const below = analyzePrice(floor - 1, landed, market);
          expect(below.profitMinor < policy.minProfitMinor || below.marginRate < policy.minMarginRate).toBe(
            true,
          );
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it("never prices below landed cost when accepted", () => {
    fc.assert(
      fc.property(costArb, marketArb, policyArb, tierArb, (cost, market, policy, tier) => {
        const result = computeRetailPrice({ cost, market, policy, tier });
        if (result.ok) expect(result.breakdown.profitMinor).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 1_000 },
    );
  });

  it("is monotonic in supplier cost", () => {
    fc.assert(
      fc.property(
        costArb,
        fc.integer({ min: 1, max: 10_000 }),
        marketArb,
        policyArb,
        tierArb,
        (cost, extra, market, policy, tier) => {
          const base = computeRetailPrice({ cost, market, policy, tier });
          const more = computeRetailPrice({
            cost: { ...cost, supplierCostUsdMinor: cost.supplierCostUsdMinor + extra },
            market,
            policy,
            tier,
          });
          expect(more.priceMinor).toBeGreaterThanOrEqual(base.priceMinor);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(costArb, marketArb, policyArb, tierArb, (cost, market, policy, tier) => {
        expect(computeRetailPrice({ cost, market, policy, tier })).toEqual(
          computeRetailPrice({ cost, market, policy, tier }),
        );
      }),
      { numRuns: 300 },
    );
  });
});
