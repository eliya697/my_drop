import { interpretBatchResult, listingBatchRequest, LISTING_MODEL } from "@dropship/ai";
import { ConcurrentModificationError } from "@dropship/core";
import {
  closeBatch,
  idsInOpenBatches,
  loadEnrichmentSource,
  openBatches,
  productsInStatus,
  recordBatch,
  recordGeneration,
  transitionProduct,
  type Executor,
} from "@dropship/db";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { JobContext } from "../queue/run";
import { applyEnrichmentResult, generationRecord, listingInputHash, toListingInput } from "./enrich";

export const BATCH_SUBMIT_QUEUE = "enrich.batch.submit" as const;
export const BATCH_POLL_QUEUE = "enrich.batch.poll" as const;
/** The API expires unfinished batches after 24h; give results a little longer to appear. */
const BATCH_TIMEOUT_MS = 26 * 60 * 60 * 1000;

export const batchSubmitSchema = z
  .object({ limit: z.number().int().min(1).max(10_000).optional() })
  .default({});
export const batchPollSchema = z.object({}).passthrough().default({});

export type BatchDeps = { db: Executor; anthropic: Anthropic; maxItems: number; now?: () => number };

/**
 * enrich.batch.submit: collects products waiting in `imported`, submits them as one Message
 * Batch (50% price), and moves them to `enriching`. The batch is recorded before any status
 * changes, so a crash can never leave products in `enriching` without a batch that owns them.
 */
export function createBatchSubmitHandler(deps: BatchDeps) {
  return async (data: z.infer<typeof batchSubmitSchema>, ctx: Pick<JobContext, "logger">) => {
    const candidates = await productsInStatus(deps.db, "imported", data.limit ?? deps.maxItems);
    const alreadyQueued = await idsInOpenBatches(deps.db, candidates);
    const requests: ReturnType<typeof listingBatchRequest>[] = [];
    const subjectIds: string[] = [];

    for (const productId of candidates) {
      if (alreadyQueued.has(productId)) continue;
      const src = await loadEnrichmentSource(deps.db, productId).catch((err: unknown) => {
        ctx.logger.warn({ productId, err }, "skipping product without a usable snapshot");
        return null;
      });
      if (!src) continue;
      requests.push(listingBatchRequest(productId, toListingInput(src)));
      subjectIds.push(productId);
    }
    if (requests.length === 0) return { submitted: 0 };

    const batch = await deps.anthropic.messages.batches.create({ requests });
    await recordBatch(deps.db, { providerBatchId: batch.id, task: "listing", subjectIds });

    let moved = 0;
    for (const id of subjectIds) {
      try {
        await transitionProduct(deps.db, {
          id,
          from: "imported",
          to: "enriching",
          actor: { type: "system" },
          data: { batchId: batch.id },
        });
        moved++;
      } catch (err) {
        if (!(err instanceof ConcurrentModificationError)) throw err;
      }
    }
    return { submitted: requests.length, moved, providerBatchId: batch.id };
  };
}

/**
 * enrich.batch.poll: for each open batch that has ended, applies every result exactly like the
 * real-time path (recorded generation → pending_review or enrichment_failed), then closes it.
 * Products the batch never answered, or batches that ran past the API's 24h window, are failed
 * so nothing stays in `enriching`.
 */
export function createBatchPollHandler(deps: Omit<BatchDeps, "maxItems">) {
  const now = deps.now ?? Date.now;

  return async (_data: unknown, ctx: Pick<JobContext, "logger" | "enqueue">) => {
    const summary = { checked: 0, ended: 0, applied: 0 };
    for (const local of await openBatches(deps.db)) {
      summary.checked++;
      const remote = await deps.anthropic.messages.batches.retrieve(local.providerBatchId);
      if (remote.processing_status !== "ended") {
        if (now() - local.submittedAt.getTime() > BATCH_TIMEOUT_MS) {
          await failAll(deps.db, local.subjectIds, "batch did not finish within 24h");
          await closeBatch(deps.db, local.id, "failed", `still ${remote.processing_status} after timeout`);
        }
        continue;
      }

      const answered = new Set<string>();
      for await (const item of await deps.anthropic.messages.batches.results(local.providerBatchId)) {
        if (!local.subjectIds.includes(item.custom_id)) continue;
        answered.add(item.custom_id);
        const result = interpretBatchResult(item.result, LISTING_MODEL);
        const src = await loadEnrichmentSource(deps.db, item.custom_id);
        const inputHash = src ? listingInputHash(toListingInput(src)) : "unknown";
        const generationId = await recordGeneration(
          deps.db,
          generationRecord(item.custom_id, inputHash, result),
        );
        await applyEnrichmentResult(deps.db, ctx.enqueue, item.custom_id, result, generationId);
        summary.applied++;
      }

      const missing = local.subjectIds.filter((id) => !answered.has(id));
      if (missing.length > 0) await failAll(deps.db, missing, "no result returned by the batch");
      await closeBatch(deps.db, local.id, "ended");
      summary.ended++;
      ctx.logger.info(
        { providerBatchId: local.providerBatchId, answered: answered.size, missing: missing.length },
        "batch applied",
      );
    }
    return summary;
  };
}

async function failAll(db: Executor, ids: readonly string[], reason: string) {
  for (const id of ids) {
    try {
      await transitionProduct(db, {
        id,
        from: "enriching",
        to: "enrichment_failed",
        actor: { type: "system" },
        reason,
      });
    } catch (err) {
      if (!(err instanceof ConcurrentModificationError)) throw err;
    }
  }
}
