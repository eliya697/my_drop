import PgBoss from "pg-boss";
import type { Logger } from "@dropship/logger";
import { DEAD_LETTER_QUEUE, QUEUES, type QueueName } from "./queues";

export type CreateBossOptions = {
  connectionString: string;
  schema: string;
  logger: Logger;
  applicationName?: string;
};

export function createBoss(opts: CreateBossOptions): PgBoss {
  const boss = new PgBoss({
    connectionString: opts.connectionString,
    schema: opts.schema,
    application_name: opts.applicationName ?? "dropship-worker",
    max: 10,
    // Archive completed jobs after 12h and delete archived jobs after 14 days.
    archiveCompletedAfterSeconds: 12 * 60 * 60,
    deleteAfterDays: 14,
    monitorStateIntervalSeconds: 60,
  });

  boss.on("error", (err) => opts.logger.error({ err }, "pg-boss error"));
  boss.on("monitor-states", (states) => opts.logger.debug({ states }, "queue states"));
  return boss;
}

/** Creates or updates every queue. Safe to run on every boot and from multiple instances. */
export async function ensureQueues(boss: PgBoss, logger: Logger): Promise<void> {
  await upsertQueue(boss, DEAD_LETTER_QUEUE, {
    retryLimit: 0,
    retryDelay: 0,
    retryBackoff: false,
    expireInSeconds: 60,
    retentionDays: 30,
  });

  for (const [name, policy] of Object.entries(QUEUES)) {
    await upsertQueue(boss, name, { ...policy, deadLetter: DEAD_LETTER_QUEUE });
  }
  logger.info({ count: Object.keys(QUEUES).length + 1 }, "queues ensured");
}

async function upsertQueue(
  boss: PgBoss,
  name: string,
  policy: (typeof QUEUES)[QueueName] & { retentionDays?: number; deadLetter?: string },
) {
  const options: PgBoss.Queue = {
    name,
    policy: "standard",
    retryLimit: policy.retryLimit,
    retryDelay: policy.retryDelay,
    retryBackoff: policy.retryBackoff,
    expireInSeconds: policy.expireInSeconds,
    retentionMinutes: (policy.retentionDays ?? 14) * 24 * 60,
    ...(policy.deadLetter ? { deadLetter: policy.deadLetter } : {}),
  };
  const existing = await boss.getQueue(name);
  if (existing) await boss.updateQueue(name, options);
  else await boss.createQueue(name, options);
}
