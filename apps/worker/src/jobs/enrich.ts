import {
  checkListingRules,
  enrichListing,
  isRetryableAnthropicError,
  LISTING_MODEL,
  LISTING_PROMPT_VERSION,
  ListingOutput,
  normalizeListing,
  type EnrichResult,
  type ListingInput,
} from "@dropship/ai";
import { ConcurrentModificationError, EntityNotFoundError } from "@dropship/core";
import {
  aiSpendMicros,
  availableSlug,
  findReusableGeneration,
  loadEnrichmentSource,
  recordGeneration,
  stableHash,
  transitionProduct,
  type EnrichmentSource,
  type Executor,
} from "@dropship/db";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Enqueue, JobContext } from "../queue/run";

export const ENRICH_QUEUE = "enrich.listing" as const;
export const PRICE_QUEUE = "price.compute" as const;
const AI_ACTOR = { type: "ai" as const };

export const enrichListingSchema = z.object({ productId: z.string().uuid() });
export type EnrichListingData = z.infer<typeof enrichListingSchema>;

export function toListingInput(src: EnrichmentSource): ListingInput {
  return {
    title: src.product.title,
    descriptionRaw: src.product.descriptionRaw,
    attributes: src.product.attributes,
    variantOptions: src.product.variants.map((v) => v.options),
    ...(src.product.rating !== undefined ? { rating: src.product.rating } : {}),
    ...(src.product.ordersCount !== undefined ? { ordersCount: src.product.ordersCount } : {}),
    shippingDays: src.shippingDays,
  };
}

/** Identical input + prompt + model ⇒ identical request; a previous success can be reused. */
export const listingInputHash = (input: ListingInput, model = LISTING_MODEL) =>
  stableHash({ promptVersion: LISTING_PROMPT_VERSION, model, input });

export type EnrichOutcome =
  | { outcome: "pending_review"; generationId: string; reused: boolean; riskFlags: string[] }
  | { outcome: "enrichment_failed"; reason: string }
  | { outcome: "skipped"; reason: string };

/**
 * Moves the product out of `enriching` according to the result: to `pending_review` with the
 * listing written atomically, or to `enrichment_failed` with the reason. Never publishes.
 */
export async function applyEnrichmentResult(
  db: Executor,
  enqueue: Enqueue,
  productId: string,
  result: EnrichResult,
  generationId: string,
): Promise<EnrichOutcome> {
  try {
    if (!result.ok) {
      const reason = `${result.status}: ${result.error}`.slice(0, 500);
      await transitionProduct(db, {
        id: productId,
        from: "enriching",
        to: "enrichment_failed",
        actor: AI_ACTOR,
        reason,
        data: { generationId },
      });
      return { outcome: "enrichment_failed", reason };
    }

    const l = result.listing;
    const slug = await availableSlug(db, l.slug, productId);
    await transitionProduct(db, {
      id: productId,
      from: "enriching",
      to: "pending_review",
      actor: AI_ACTOR,
      data: { generationId, riskFlags: l.risk_flags, confidence: l.confidence },
      patch: {
        title: l.title,
        seoTitle: l.seo_title,
        metaDescription: l.meta_description,
        slug,
        descriptionHtml: l.description_html,
        bullets: l.bullets,
        category: l.category,
        tags: l.tags,
        riskFlags: l.risk_flags,
        positioning: l.positioning,
        activeAiGenerationId: generationId,
      },
    });
    await enqueue(PRICE_QUEUE, { productId });
    return { outcome: "pending_review", generationId, reused: false, riskFlags: l.risk_flags };
  } catch (err) {
    // Someone moved the product (archived, re-queued) while the model was running: their change wins.
    if (err instanceof ConcurrentModificationError)
      return { outcome: "skipped", reason: `status is now ${err.actual.status}` };
    throw err;
  }
}

export function generationRecord(productId: string, inputHash: string, result: EnrichResult) {
  return {
    task: "listing" as const,
    subjectType: "product",
    subjectId: productId,
    model: result.meta.model,
    promptVersion: result.meta.promptVersion,
    inputHash,
    status: result.ok ? ("ok" as const) : result.status,
    output: result.ok ? result.listing : (result.output ?? null),
    error: result.ok ? null : result.error,
    inputTokens: result.meta.usage?.input_tokens ?? null,
    outputTokens: result.meta.usage?.output_tokens ?? null,
    cacheReadTokens: result.meta.usage?.cache_read_input_tokens ?? null,
    costUsdMicros: result.meta.costUsdMicros,
    latencyMs: result.meta.latencyMs,
    fallbackUsed: result.meta.fallbackUsed,
    batch: result.meta.batch,
  };
}

export type EnrichListingDeps = {
  db: Executor;
  anthropic: Anthropic;
  dailyBudgetUsd: number;
  /** Fresh attempts when the output is malformed or breaks a business rule. */
  maxAttempts?: number;
};

/**
 * enrich.listing: writes the Hebrew listing for one product in `enriching`.
 *  - an identical earlier success is reused at no cost;
 *  - the daily AI budget is enforced before every call;
 *  - malformed/rule-breaking output gets one more try, then the product goes to
 *    `enrichment_failed` for a human;
 *  - transient API errors are retried by the queue; on the final attempt the product is failed
 *    instead of being left in `enriching` forever.
 */
export function createEnrichListingHandler(deps: EnrichListingDeps) {
  const maxAttempts = deps.maxAttempts ?? 2;

  return async (
    data: EnrichListingData,
    ctx: Pick<JobContext, "enqueue" | "logger" | "isFinalAttempt">,
  ): Promise<EnrichOutcome> => {
    const src = await loadEnrichmentSource(deps.db, data.productId);
    if (!src) throw new EntityNotFoundError("product", data.productId);
    if (src.status !== "enriching") return { outcome: "skipped", reason: `status is ${src.status}` };

    const input = toListingInput(src);
    const inputHash = listingInputHash(input);

    const previous = await findReusableGeneration(deps.db, "listing", inputHash);
    if (previous) {
      const parsed = ListingOutput.safeParse(previous.output);
      if (parsed.success && checkListingRules(parsed.data).length === 0) {
        const listing = normalizeListing(parsed.data);
        const outcome = await applyEnrichmentResult(
          deps.db,
          ctx.enqueue,
          data.productId,
          { ok: true, listing, meta: reusedMeta() },
          previous.id,
        );
        return outcome.outcome === "pending_review" ? { ...outcome, reused: true } : outcome;
      }
    }

    let last: { result: EnrichResult; generationId: string } | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const spent = await aiSpendMicros(deps.db);
      if (spent >= deps.dailyBudgetUsd * 1_000_000) {
        const reason = `daily AI budget of $${deps.dailyBudgetUsd} reached; re-queue tomorrow`;
        ctx.logger.warn({ spentUsd: spent / 1e6 }, reason);
        try {
          await transitionProduct(deps.db, {
            id: data.productId,
            from: "enriching",
            to: "enrichment_failed",
            actor: AI_ACTOR,
            reason,
          });
        } catch (err) {
          if (!(err instanceof ConcurrentModificationError)) throw err;
        }
        return { outcome: "enrichment_failed", reason };
      }

      let result: EnrichResult;
      try {
        result = await enrichListing(deps.anthropic, input);
      } catch (err) {
        if (!isRetryableAnthropicError(err) || !ctx.isFinalAttempt) throw err;
        const reason = `Claude API unavailable after retries: ${(err as Error).message}`.slice(0, 500);
        await transitionProduct(deps.db, {
          id: data.productId,
          from: "enriching",
          to: "enrichment_failed",
          actor: AI_ACTOR,
          reason,
        });
        return { outcome: "enrichment_failed", reason };
      }

      const generationId = await recordGeneration(
        deps.db,
        generationRecord(data.productId, inputHash, result),
      );
      last = { result, generationId };
      ctx.logger.info(
        {
          attempt,
          status: result.ok ? "ok" : result.status,
          costUsd: result.meta.costUsdMicros / 1e6,
          fallbackUsed: result.meta.fallbackUsed,
        },
        "listing generation",
      );
      const retryable =
        !result.ok && (result.status === "parse_error" || result.status === "rejected_by_validator");
      if (!retryable) break;
    }

    return applyEnrichmentResult(deps.db, ctx.enqueue, data.productId, last!.result, last!.generationId);
  };
}

function reusedMeta() {
  return {
    model: LISTING_MODEL,
    promptVersion: LISTING_PROMPT_VERSION,
    usage: null,
    costUsdMicros: 0,
    latencyMs: 0,
    stopReason: null,
    fallbackUsed: false,
    batch: false,
  };
}
