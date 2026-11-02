import {
  ConcurrencyLimiter,
  fetchImage,
  ImageRejectedError,
  processImage,
  productImageKey,
  type FetchImageOptions,
  type ObjectStorage,
} from "@dropship/adapters";
import { listPendingImages, markImageFailed, markImageStored, type Executor } from "@dropship/db";
import { z } from "zod";
import type { JobContext } from "../queue/run";

export const importMediaSchema = z.object({ productId: z.string().uuid() });
export type ImportMediaData = z.infer<typeof importMediaSchema>;

export type ImportMediaDeps = {
  db: Executor;
  storage: ObjectStorage;
  fetchOptions?: FetchImageOptions;
  concurrency?: number;
};

export type ImportMediaResult = { stored: number; rejected: number; retryable: number };

export class TransientMediaError extends Error {
  constructor(readonly failures: number) {
    super(`${failures} image(s) failed transiently; will retry`);
    this.name = "TransientMediaError";
  }
}

/**
 * import.media: downloads every not-yet-processed image of a product, normalizes it to WebP,
 * and uploads it under a content-derived key. Permanently bad images are marked and skipped;
 * transient failures make the job retry, and only still-pending images are reprocessed.
 */
export function createImportMediaHandler(deps: ImportMediaDeps) {
  const limiter = new ConcurrencyLimiter(deps.concurrency ?? 4);

  return async (data: ImportMediaData, ctx: Pick<JobContext, "logger">): Promise<ImportMediaResult> => {
    const pending = await listPendingImages(deps.db, data.productId);
    const result: ImportMediaResult = { stored: 0, rejected: 0, retryable: 0 };

    await Promise.all(
      pending.map((image) =>
        limiter.run(async () => {
          try {
            const original = await fetchImage(image.sourceUrl, deps.fetchOptions);
            const processed = await processImage(original);
            const key = productImageKey(data.productId, image.sourceUrl);
            await deps.storage.put(key, processed.data, processed.contentType);
            await markImageStored(deps.db, image.id, {
              storageKey: key,
              width: processed.width,
              height: processed.height,
            });
            result.stored++;
          } catch (err) {
            if (err instanceof ImageRejectedError && !err.retryable) {
              await markImageFailed(deps.db, image.id, err.message);
              ctx.logger.warn({ imageId: image.id, reason: err.message }, "image rejected");
              result.rejected++;
              return;
            }
            ctx.logger.warn({ imageId: image.id, err }, "image failed transiently");
            result.retryable++;
          }
        }),
      ),
    );

    if (result.retryable > 0) throw new TransientMediaError(result.retryable);
    return result;
  };
}
