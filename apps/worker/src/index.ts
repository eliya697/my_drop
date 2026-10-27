import { EnvValidationError, loadWorkerEnv } from "@dropship/config";
import { createDb } from "@dropship/db";
import { createLogger, type Logger } from "@dropship/logger";
import { databaseCheck, queueCheck } from "./health/checks";
import { startHealthServer, type HealthServer } from "./health/server";
import { HEARTBEAT_QUEUE, registerHeartbeat } from "./jobs/heartbeat";
import { createBoss, ensureQueues } from "./queue/boss";

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
