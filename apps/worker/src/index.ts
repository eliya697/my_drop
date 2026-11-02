import { EnvValidationError, loadWorkerEnv } from "@dropship/config";
import { createDb } from "@dropship/db";
import { createLogger, type Logger } from "@dropship/logger";
import { databaseCheck, queueCheck } from "./health/checks";
import { startHealthServer, type HealthServer } from "./health/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildAliExpress } from "./integrations/aliexpress";
import {
  BATCH_POLL_QUEUE,
  BATCH_SUBMIT_QUEUE,
  batchPollSchema,
  batchSubmitSchema,
  createBatchPollHandler,
  createBatchSubmitHandler,
} from "./jobs/enrich-batch";
import { createEnrichListingHandler, ENRICH_QUEUE, enrichListingSchema, PRICE_QUEUE } from "./jobs/enrich";
import { createPriceComputeHandler, priceComputeSchema } from "./jobs/price";
import { buildStorage } from "./integrations/storage";
import { HEARTBEAT_QUEUE, registerHeartbeat } from "./jobs/heartbeat";
import { createImportFetchHandler, IMPORT_FETCH_QUEUE, importFetchSchema } from "./jobs/import-fetch";
import { createImportMediaHandler, importMediaSchema } from "./jobs/import-media";
import { createBoss, ensureQueues } from "./queue/boss";
import { registerJob } from "./queue/run";

async function main() {
  let env;
  try {
    env = loadWorkerEnv();
  } catch (err) {
    // The logger is not configured yet; the message lists key names only, never values.
    process.stderr.write(`${err instanceof EnvValidationError ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const logger = createLogger({ service: "worker", level: env.LOG_LEVEL, appEnv: env.APP_ENV });
  logger.info({ appEnv: env.APP_ENV, node: process.version }, "worker starting");

  let accepting = false;
  // Filled in once listening; shutdown may run before that if startup fails part-way.
  const handles: { health?: HealthServer } = {};

  // pg-boss holds its own pool; this small pool serves readiness probes and (later) job handlers.
  const database = createDb(env.DIRECT_DATABASE_URL, {
    max: 5,
    prepare: true,
    applicationName: "dropship-worker",
  });
  const boss = createBoss({
    connectionString: env.DIRECT_DATABASE_URL,
    schema: env.WORKER_PGBOSS_SCHEMA,
    logger,
  });

  const shutdown = createShutdown({
    logger,
    timeoutMs: env.WORKER_SHUTDOWN_TIMEOUT_MS,
    steps: [
      ["stop accepting work", async () => void (accepting = false)],
      [
        "stop pg-boss",
        () => boss.stop({ graceful: true, wait: true, timeout: env.WORKER_SHUTDOWN_TIMEOUT_MS - 2_000 }),
      ],
      ["close health server", async () => handles.health?.close()],
      ["close database pool", () => database.close()],
    ],
  });

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    void shutdown("uncaughtException", 1);
  });

  // Liveness comes up first so the platform does not kill the process during a slow start.
  handles.health = await startHealthServer({
    port: env.HEALTH_PORT,
    logger,
    isAcceptingWork: () => accepting,
    checks: {
      database: databaseCheck(database.sql),
      queue: queueCheck({
        sql: database.sql,
        schema: env.WORKER_PGBOSS_SCHEMA,
        heartbeatQueue: HEARTBEAT_QUEUE,
        heartbeatStaleSeconds: env.WORKER_HEARTBEAT_STALE_SECONDS,
        stuckJobMinutes: env.WORKER_STUCK_JOB_MINUTES,
      }),
    },
  });

  await boss.start();
  logger.info({ schema: env.WORKER_PGBOSS_SCHEMA }, "pg-boss started");
  await ensureQueues(boss, logger);
  await registerHeartbeat(boss, logger);

  // ---- catalog import ----------------------------------------------------------------------
  const storage = buildStorage(env);
  await registerJob(
    boss,
    "import.media",
    importMediaSchema,
    createImportMediaHandler({ db: database.db, storage }),
    {
      logger,
    },
  );

  const aliexpress = buildAliExpress(env, database.db, logger);
  if ("missing" in aliexpress) {
    // Allowed outside production only; the env schema requires these keys in production.
    logger.warn(
      { missing: aliexpress.missing },
      `${IMPORT_FETCH_QUEUE} disabled: AliExpress is not configured`,
    );
  } else {
    await registerJob(
      boss,
      IMPORT_FETCH_QUEUE,
      importFetchSchema,
      createImportFetchHandler({
        db: database.db,
        catalog: aliexpress.catalog,
        shipTo: env.IMPORT_SHIP_TO,
        maxShippingDays: env.IMPORT_MAX_SHIPPING_DAYS,
        autoEnrich: env.AI_ENRICH_MODE === "realtime" && Boolean(env.ANTHROPIC_API_KEY),
      }),
      { logger },
    );
  }

  // ---- AI enrichment and pricing -----------------------------------------------------------
  await registerJob(
    boss,
    PRICE_QUEUE,
    priceComputeSchema,
    createPriceComputeHandler({
      db: database.db,
      market: env.PRICING_USD_ILS_RATE
        ? {
            fxUsdToIls: env.PRICING_USD_ILS_RATE,
            fxBuffer: env.PRICING_FX_BUFFER,
            vatRate: env.PRICING_VAT_RATE,
            paymentFeeRate: env.PRICING_PAYMENT_FEE_RATE,
            paymentFeeFixedMinor: env.PRICING_PAYMENT_FEE_FIXED_MINOR,
          }
        : null,
    }),
    { logger },
  );

  if (!env.ANTHROPIC_API_KEY) {
    logger.warn(`${ENRICH_QUEUE} disabled: ANTHROPIC_API_KEY is not set`);
  } else {
    // The SDK retries 429/5xx itself; the queue retries anything that still fails.
    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 180_000 });
    await registerJob(
      boss,
      ENRICH_QUEUE,
      enrichListingSchema,
      createEnrichListingHandler({
        db: database.db,
        anthropic,
        dailyBudgetUsd: env.ANTHROPIC_DAILY_BUDGET_USD,
      }),
      { logger },
    );
    // Polling always runs so batches submitted earlier finish even after switching modes.
    await registerJob(
      boss,
      BATCH_POLL_QUEUE,
      batchPollSchema,
      createBatchPollHandler({ db: database.db, anthropic }),
      {
        logger,
      },
    );
    await boss.schedule(BATCH_POLL_QUEUE, "*/10 * * * *", {}, { tz: "UTC" });
    if (env.AI_ENRICH_MODE === "batch") {
      await registerJob(
        boss,
        BATCH_SUBMIT_QUEUE,
        batchSubmitSchema,
        createBatchSubmitHandler({ db: database.db, anthropic, maxItems: env.AI_BATCH_MAX_ITEMS }),
        { logger },
      );
      await boss.schedule(BATCH_SUBMIT_QUEUE, "*/30 * * * *", {}, { tz: "UTC" });
    } else {
      await boss.unschedule(BATCH_SUBMIT_QUEUE);
    }
    logger.info(
      { mode: env.AI_ENRICH_MODE, dailyBudgetUsd: env.ANTHROPIC_DAILY_BUDGET_USD },
      "AI enrichment enabled",
    );
  }

  accepting = true;
  logger.info("worker ready");
}

type ShutdownStep = readonly [name: string, run: () => Promise<unknown>];

function createShutdown(opts: { logger: Logger; timeoutMs: number; steps: readonly ShutdownStep[] }) {
  let inProgress = false;
  return async (reason: string, exitCode = 0) => {
    if (inProgress) return;
    inProgress = true;
    opts.logger.info({ reason }, "shutting down");

    const forceExit = setTimeout(() => {
      opts.logger.error({ timeoutMs: opts.timeoutMs }, "graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, opts.timeoutMs);
    forceExit.unref();

    let code = exitCode;
    for (const [name, run] of opts.steps) {
      try {
        await run();
        opts.logger.debug({ step: name }, "shutdown step complete");
      } catch (err) {
        code = 1;
        opts.logger.error({ err, step: name }, "shutdown step failed");
      }
    }
    opts.logger.info({ exitCode: code }, "shutdown complete");
    opts.logger.flush();
    process.exit(code);
  };
}

main().catch((err: unknown) => {
  process.stderr.write(
    `worker failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
