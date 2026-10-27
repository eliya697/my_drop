import type PgBoss from "pg-boss";
import type { Logger } from "@dropship/logger";

export const HEARTBEAT_QUEUE = "system.heartbeat";
export const HEARTBEAT_CRON = "* * * * *";

export type HeartbeatData = Record<string, never>;

/**
 * A job scheduled every minute and processed by this service. Readiness checks the time of the
 * last completed heartbeat, which proves end to end that the scheduler, the queue, and at least
 * one worker are all functioning — not merely that the process is up.
 */
export async function registerHeartbeat(boss: PgBoss, logger: Logger): Promise<void> {
  await boss.schedule(HEARTBEAT_QUEUE, HEARTBEAT_CRON, {}, { tz: "UTC" });
  await boss.work<HeartbeatData>(HEARTBEAT_QUEUE, { batchSize: 1 }, async ([job]) => {
    logger.debug({ jobId: job?.id, queue: HEARTBEAT_QUEUE }, "heartbeat");
  });
}
