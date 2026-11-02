import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { fakeAnthropic, parsedResponse, validListing } from "@dropship/ai/testing";
import type { ShippingQuote, SupplierProduct } from "@dropship/core";
import {
  aiBatches,
  aiGenerations,
  createDb,
  pricingRules,
  products,
  productVariants,
  transitionProduct,
  upsertImportedProduct,
  type DbHandle,
} from "@dropship/db";
import { runMigrations } from "@dropship/db/migrate";
import { createLogger } from "@dropship/logger";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Enqueue } from "../queue/run";
import { createEnrichListingHandler, PRICE_QUEUE } from "./enrich";
import { createBatchPollHandler, createBatchSubmitHandler } from "./enrich-batch";
import { createPriceComputeHandler } from "./price";

const url = process.env.TEST_DATABASE_URL;
const logger = createLogger({
  service: "test",
  level: "silent",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

function recorder() {
  const sent: { queue: string; data: unknown }[] = [];
  const enqueue: Enqueue = async (queue, data) => {
    sent.push({ queue, data });
    return randomUUID();
  };
  return { enqueue, sent };
}

const MARKET = {
  fxUsdToIls: 3.7,
  fxBuffer: 0.03,
  vatRate: 0.18,
  paymentFeeRate: 0.029,
  paymentFeeFixedMinor: 120,
};

describe.skipIf(!url)("enrichment and pricing jobs (integration)", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!, { max: 4 });
  });
  afterAll(async () => {
    await handle?.close();
  });

  /** Imports a fresh product (unique title, so its listing input is unique) and returns its id. */
  async function importProduct(opts: { status?: "imported" | "enriching"; costCents?: number } = {}) {
    const externalId = randomUUID();
    const product: SupplierProduct = {
      supplier: "aliexpress",
      externalId,
      title: `LED Desk Lamp ${externalId}`,
      descriptionRaw: "<p>Touch dimmable lamp with USB charging.</p>",
      images: [],
      attributes: { Material: "ABS" },
      variants: [
        { skuId: "w", options: { Color: "White" }, unitCost: usd(opts.costCents ?? 1000), stock: 20 },
        { skuId: "b", options: { Color: "Black" }, unitCost: usd(opts.costCents ?? 1000), stock: 20 },
      ],
      sellerId: "s",
      available: true,
      raw: { externalId },
    };
    const q = (skuId: string): ShippingQuote => ({
      skuId,
      method: "STD",
      cost: usd(200),
      daysMin: 10,
      daysMax: 20,
      tracked: true,
    });
    const r = await upsertImportedProduct(handle.db, {
      product,
      variants: [
        { skuId: "w", shipping: q("w") },
        { skuId: "b", shipping: q("b") },
      ],
      actor: { type: "system" },
    });
    if ((opts.status ?? "enriching") === "enriching") {
      await transitionProduct(handle.db, {
        id: r.productId,
        from: "imported",
        to: "enriching",
        actor: { type: "system" },
      });
    }
    return r.productId;
  }

  const load = async (id: string) => (await handle.db.select().from(products).where(eq(products.id, id)))[0]!;
  const generations = (id: string) =>
    handle.db
      .select()
      .from(aiGenerations)
      .where(eq(aiGenerations.subjectId, id))
      .orderBy(aiGenerations.createdAt);
  const ctx = (enqueue: Enqueue, isFinalAttempt = false) => ({ enqueue, logger, isFinalAttempt });

  describe("enrich.listing", () => {
    it("writes the listing, moves to pending_review, records cost, and queues pricing", async () => {
      const id = await importProduct();
      const { client, calls } = fakeAnthropic({
        parse: () =>
          parsedResponse(
            validListing({ slug: `lamp-${id.slice(0, 8)}`, risk_flags: ["electrical_plug_type"] }),
          ),
      });
      const { enqueue, sent } = recorder();
      const outcome = await createEnrichListingHandler({
        db: handle.db,
        anthropic: client,
        dailyBudgetUsd: 1000,
      })({ productId: id }, ctx(enqueue));

      expect(outcome).toMatchObject({ outcome: "pending_review", reused: false });
      expect(calls.parse).toHaveLength(1);
      expect(String((calls.parse[0]!.messages as { content: string }[])[0]!.content)).toContain(
        "10-20 business days",
      );

      const p = await load(id);
      expect(p).toMatchObject({
        status: "pending_review",
        title: validListing().title,
        slug: `lamp-${id.slice(0, 8)}`,
        positioning: "standard",
        riskFlags: ["electrical_plug_type"],
        category: "תאורה לבית",
      });
      const gens = await generations(id);
      expect(gens).toHaveLength(1);
      expect(gens[0]).toMatchObject({
        status: "ok",
        task: "listing",
        model: "claude-opus-5-5",
        costUsdMicros: 38_000,
        promptVersion: "listing@1",
      });
      expect(p.activeAiGenerationId).toBe(gens[0]!.id);
      expect(sent).toEqual([{ queue: PRICE_QUEUE, data: { productId: id } }]);
    });

    it("reuses an identical earlier generation without calling the API", async () => {
      const id = await importProduct();
      const first = fakeAnthropic({
        parse: () => parsedResponse(validListing({ slug: `reuse-${id.slice(0, 8)}` })),
      });
      await createEnrichListingHandler({ db: handle.db, anthropic: first.client, dailyBudgetUsd: 1000 })(
        { productId: id },
        ctx(recorder().enqueue),
      );

      // Send the same product through enrichment again (e.g. an admin asked to regenerate).
      await transitionProduct(handle.db, {
        id,
        from: "pending_review",
        to: "enriching",
        actor: { type: "system" },
      });
      const second = fakeAnthropic({ parse: () => parsedResponse(validListing()) });
      const outcome = await createEnrichListingHandler({
        db: handle.db,
        anthropic: second.client,
        dailyBudgetUsd: 1000,
      })({ productId: id }, ctx(recorder().enqueue));
      expect(outcome).toMatchObject({ outcome: "pending_review", reused: true });
      expect(second.calls.parse).toHaveLength(0);
    });

    it("gives rule-breaking output one more try, then fails the product for a human", async () => {
      const id = await importProduct();
      const { client, calls } = fakeAnthropic({
        parse: () => parsedResponse(validListing({ title: "English title only" })),
      });
      const outcome = await createEnrichListingHandler({
        db: handle.db,
        anthropic: client,
        dailyBudgetUsd: 1000,
      })({ productId: id }, ctx(recorder().enqueue));
      expect(outcome).toMatchObject({ outcome: "enrichment_failed" });
      expect(calls.parse).toHaveLength(2);
      expect((await generations(id)).map((g) => g.status)).toEqual([
        "rejected_by_validator",
        "rejected_by_validator",
      ]);
      expect((await load(id)).status).toBe("enrichment_failed");
    });

    it("succeeds when the second attempt is valid", async () => {
      const id = await importProduct();
      let n = 0;
      const { client } = fakeAnthropic({
        parse: () =>
          parsedResponse(
            ++n === 1
              ? validListing({ slug: "Not A Slug!!", title: "x" })
              : validListing({ slug: `retry-${id.slice(0, 8)}` }),
          ),
      });
      const outcome = await createEnrichListingHandler({
        db: handle.db,
        anthropic: client,
        dailyBudgetUsd: 1000,
      })({ productId: id }, ctx(recorder().enqueue));
      expect(outcome.outcome).toBe("pending_review");
    });

    it("records a refusal and sends the product to manual review", async () => {
      const id = await importProduct();
      const { client } = fakeAnthropic({
        parse: () =>
          parsedResponse(null, {
            stop_reason: "refusal",
            stop_details: { category: "general_harms", explanation: null },
          }),
      });
      const outcome = await createEnrichListingHandler({
        db: handle.db,
        anthropic: client,
        dailyBudgetUsd: 1000,
      })({ productId: id }, ctx(recorder().enqueue));
      expect(outcome).toMatchObject({
        outcome: "enrichment_failed",
        reason: expect.stringMatching(/refusal/),
      });
      expect((await generations(id))[0]!.status).toBe("refusal");
    });

    it("stops before calling the API when the daily budget is spent", async () => {
      const id = await importProduct();
      const { client, calls } = fakeAnthropic({ parse: () => parsedResponse(validListing()) });
      const outcome = await createEnrichListingHandler({
        db: handle.db,
        anthropic: client,
        dailyBudgetUsd: 0.000001,
      })({ productId: id }, ctx(recorder().enqueue));
      expect(outcome).toMatchObject({
        outcome: "enrichment_failed",
        reason: expect.stringMatching(/budget/),
      });
      expect(calls.parse).toHaveLength(0);
    });

    it("lets the queue retry transient API errors, and fails the product on the final attempt", async () => {
      const id = await importProduct();
      const { client } = fakeAnthropic({
        parse: () => {
          throw new Anthropic.InternalServerError(529, {}, "overloaded", new Headers());
        },
      });
      const handler = createEnrichListingHandler({ db: handle.db, anthropic: client, dailyBudgetUsd: 1000 });
      await expect(handler({ productId: id }, ctx(recorder().enqueue, false))).rejects.toBeInstanceOf(
        Anthropic.APIError,
      );
      expect((await load(id)).status).toBe("enriching");

      expect(await handler({ productId: id }, ctx(recorder().enqueue, true))).toMatchObject({
        outcome: "enrichment_failed",
      });
      expect((await load(id)).status).toBe("enrichment_failed");
    });

    it("skips products that are no longer enriching", async () => {
      const id = await importProduct({ status: "imported" });
      const { client, calls } = fakeAnthropic({ parse: () => parsedResponse(validListing()) });
      expect(
        await createEnrichListingHandler({ db: handle.db, anthropic: client, dailyBudgetUsd: 1000 })(
          { productId: id },
          ctx(recorder().enqueue),
        ),
      ).toMatchObject({ outcome: "skipped" });
      expect(calls.parse).toHaveLength(0);
    });

    it("de-duplicates slugs across products", async () => {
      const slug = `dup-${randomUUID().slice(0, 8)}`;
      const a = await importProduct();
      const b = await importProduct();
      for (const id of [a, b]) {
        const { client } = fakeAnthropic({ parse: () => parsedResponse(validListing({ slug })) });
        await createEnrichListingHandler({ db: handle.db, anthropic: client, dailyBudgetUsd: 1000 })(
          { productId: id },
          ctx(recorder().enqueue),
        );
      }
      expect((await load(a)).slug).toBe(slug);
      expect((await load(b)).slug).toBe(`${slug}-${b.replace(/-/g, "").slice(0, 6)}`);
    });
  });

  describe("price.compute", () => {
    it("prices every active variant with the global rule and stores the breakdown", async () => {
      const id = await importProduct();
      const result = await createPriceComputeHandler({ db: handle.db, market: MARKET })(
        { productId: id },
        { logger },
      );
      expect(result).toMatchObject({ priced: 2, rejected: 0, tier: "standard", ruleScope: "global" });

      const variants = await handle.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.productId, id));
      for (const v of variants) {
        expect(v.priceMinor! % 1000).toBe(990); // charm price ₪X9.90
        expect(v.priceCalc).toMatchObject({ ok: true, ruleScope: "global", fxUsdToIls: 3.7 });
      }
    });

    it("uses the product's AI positioning and a more specific rule when one exists", async () => {
      const id = await importProduct();
      await handle.db.update(products).set({ positioning: "premium" }).where(eq(products.id, id));
      const base = await createPriceComputeHandler({ db: handle.db, market: MARKET })(
        { productId: id },
        { logger },
      );
      expect(base).toMatchObject({ tier: "premium", ruleScope: "global" });

      await handle.db
        .insert(pricingRules)
        .values({ scope: `product:${id}`, targetMarginPct: "20", markupPct: "100", minProfitMinor: 1500 });
      const specific = await createPriceComputeHandler({ db: handle.db, market: MARKET })(
        { productId: id },
        { logger },
      );
      expect(specific).toMatchObject({ ruleScope: `product:${id}` });
    });

    it("stores a null price with the violations when a hard floor cannot be met", async () => {
      const id = await importProduct({ costCents: 10 });
      await handle.db.insert(pricingRules).values({
        scope: `product:${id}`,
        targetMarginPct: "20",
        markupPct: "0",
        minProfitMinor: 50_000,
        maxPriceMinor: 1990,
      });
      const result = await createPriceComputeHandler({ db: handle.db, market: MARKET })(
        { productId: id },
        { logger },
      );
      expect(result).toMatchObject({ priced: 0, rejected: 2 });
      const [v] = await handle.db.select().from(productVariants).where(eq(productVariants.productId, id));
      expect(v!.priceMinor).toBeNull();
      expect(v!.priceCalc).toMatchObject({
        ok: false,
        violations: expect.arrayContaining(["below_min_profit"]),
      });
    });

    it("skips cleanly when no exchange rate is configured", async () => {
      const id = await importProduct();
      expect(
        await createPriceComputeHandler({ db: handle.db, market: null })({ productId: id }, { logger }),
      ).toEqual({
        skipped: "exchange rate not configured",
      });
    });
  });

  describe("Batches API path", () => {
    it("submits imported products, then applies results and fails unanswered ones", async () => {
      // Isolate from products other tests left in `imported`.
      await handle.db.update(products).set({ status: "archived" }).where(eq(products.status, "imported"));
      const ok = await importProduct({ status: "imported" });
      const refused = await importProduct({ status: "imported" });
      const missing = await importProduct({ status: "imported" });
      const providerBatchId = `msgbatch_${randomUUID()}`;

      const { client, calls } = fakeAnthropic({
        batches: {
          create: () => ({ id: providerBatchId, processing_status: "in_progress" }),
          retrieve: (id) => ({ id, processing_status: "ended" }),
          results: () => [
            {
              custom_id: ok,
              result: {
                type: "succeeded",
                message: {
                  model: "claude-opus-5-5",
                  stop_reason: "end_turn",
                  stop_details: null,
                  usage: { input_tokens: 2000, output_tokens: 1500 },
                  content: [
                    { type: "text", text: JSON.stringify(validListing({ slug: `batch-${ok.slice(0, 8)}` })) },
                  ],
                },
              },
            },
            {
              custom_id: refused,
              result: {
                type: "succeeded",
                message: {
                  model: "claude-opus-5-5",
                  stop_reason: "refusal",
                  stop_details: { category: "general_harms" },
                  usage: { input_tokens: 10, output_tokens: 0 },
                  content: [],
                },
              },
            },
          ],
        },
      });

      const submit = await createBatchSubmitHandler({ db: handle.db, anthropic: client, maxItems: 10 })(
        {},
        { logger },
      );
      expect(submit).toMatchObject({ submitted: 3, moved: 3, providerBatchId });
      const requests = (
        calls.batchCreate[0] as { requests: { custom_id: string; params: Record<string, unknown> }[] }
      ).requests;
      expect(requests.map((r) => r.custom_id).sort()).toEqual([ok, refused, missing].sort());
      expect(requests[0]!.params).not.toHaveProperty("fallbacks");
      for (const id of [ok, refused, missing]) expect((await load(id)).status).toBe("enriching");

      // A second submit must not resubmit products already in a batch.
      expect(
        await createBatchSubmitHandler({ db: handle.db, anthropic: client, maxItems: 10 })({}, { logger }),
      ).toEqual({ submitted: 0 });

      const { enqueue, sent } = recorder();
      const poll = await createBatchPollHandler({ db: handle.db, anthropic: client })(
        {},
        { logger, enqueue },
      );
      expect(poll).toMatchObject({ ended: 1, applied: 2 });

      expect((await load(ok)).status).toBe("pending_review");
      expect((await load(refused)).status).toBe("enrichment_failed");
      expect((await load(missing)).status).toBe("enrichment_failed");
      expect(sent).toEqual([{ queue: PRICE_QUEUE, data: { productId: ok } }]);

      const [gen] = await handle.db
        .select()
        .from(aiGenerations)
        .where(and(eq(aiGenerations.subjectId, ok), eq(aiGenerations.batch, true)));
      expect(gen).toMatchObject({ status: "ok", costUsdMicros: 19_000 });
      const [batch] = await handle.db
        .select()
        .from(aiBatches)
        .where(eq(aiBatches.providerBatchId, providerBatchId));
      expect(batch).toMatchObject({ status: "ended", itemCount: 3 });
    });
  });
});
