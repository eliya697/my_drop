import { DomainError, SupplierError } from "@dropship/core";
import type { Logger } from "@dropship/logger";
import type PgBoss from "pg-boss";
import { ZodError, type z } from "zod";
import { DEAD_LETTER_QUEUE, type QueueName } from "./queues";

/** Marker for failures that a retry cannot fix (bad input, rejected by the supplier, ...). */
export class PermanentJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentJobError";
    this.code = code;
  }
}

/** Retryable unless we positively know a retry is pointless. Unknown errors are retried. */
export function isPermanent(err: unknown): boolean {
  if (err instanceof PermanentJobError || err instanceof ZodError) return true;
  if (err instanceof SupplierError) return !err.retryable;
  if (err instanceof DomainError) return true;
  if (err && typeof err === "object" && "retryable" in err)
    return (err as { retryable: unknown }).retryable === false;
  return false;
}

export function errorSummary(err: unknown): { name: string; code?: string; message: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, ...(typeof code === "string" ? { code } : {}), message: err.message };
  }
  return { name: "Unknown", message: String(err) };
}

export type Enqueue = <T extends object>(
  queue: QueueName,
  data: T,
  options?: PgBoss.SendOptions,
) => Promise<string | null>;

export const enqueueWith =
  (boss: PgBoss): Enqueue =>
  (queue, data, options) =>
    boss.send(queue, data, options ?? {});

export type JobContext = {
  jobId: string;
  queue: QueueName;
  logger: Logger;
  enqueue: Enqueue;
  /** 0 on the first run. */
  retryCount: number;
  /** True when a thrown error will not be retried again (the queue's retry limit is reached). */
  isFinalAttempt: boolean;
};

/**
 * Registers a handler with uniform validation, logging and failure routing:
 *  - job data is validated with `schema` (invalid data is permanent);
 *  - permanent failures are written to the dead-letter queue and the job completes, so pg-boss
 *    does not burn retries on them;
 *  - everything else is rethrown and retried with the queue's backoff policy.
 */
export async function registerJob<S extends z.ZodTypeAny>(
  boss: PgBoss,
  queue: QueueName,
  schema: S,
  handler: (data: z.infer<S>, ctx: JobContext) => Promise<unknown>,
  deps: { logger: Logger; batchSize?: number },
): Promise<void> {
  const enqueue = enqueueWith(boss);
  await boss.work<unknown>(queue, { batchSize: deps.batchSize ?? 1, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      const logger = deps.logger.child({ queue, jobId: job.id, retryCount: job.retryCount });
      const started = performance.now();
      try {
        const result = await handler(schema.parse(job.data), {
          jobId: job.id,
          queue,
          logger,
          enqueue,
          retryCount: job.retryCount,
          isFinalAttempt: job.retryCount >= job.retryLimit,
        });
        logger.info({ durationMs: Math.round(performance.now() - started), result }, "job completed");
      } catch (err) {
        const durationMs = Math.round(performance.now() - started);
        if (!isPermanent(err)) {
          logger.warn({ err, durationMs }, "job failed; will retry");
          throw err;
        }
        logger.error({ err, durationMs }, "job failed permanently; sent to dead letter");
        await boss.send(DEAD_LETTER_QUEUE, {
          queue,
          jobId: job.id,
          data: job.data,
          error: errorSummary(err),
        });
      }
    }
  });
}
