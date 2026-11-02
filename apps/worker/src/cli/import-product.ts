/**
 * Queues AliExpress products for import.
 *
 *   pnpm import:product <url-or-id> [<url-or-id> ...]
 *
 * Every argument is validated before anything is queued. The same product is queued at most
 * once per 5-minute window (pg-boss singleton throttling); re-importing later is safe and
 * simply re-syncs the product.
 */
import { InvalidProductReferenceError, parseAliExpressProductId } from "@dropship/adapters";
import { loadWorkerEnv } from "@dropship/config";
import PgBoss from "pg-boss";
import { IMPORT_FETCH_QUEUE, type ImportFetchData } from "../jobs/import-fetch";

const out = (line = "") => process.stdout.write(`${line}\n`);

async function main() {
  const inputs = process.argv.slice(2).filter((a) => a.trim() !== "");
  if (inputs.length === 0) {
    out("usage: pnpm import:product <aliexpress-url-or-id> [...]");
    process.exit(2);
  }

  const jobs: ImportFetchData[] = [];
  const errors: string[] = [];
  for (const input of inputs) {
    try {
      const externalProductId = parseAliExpressProductId(input);
      jobs.push({
        externalProductId,
        ...(input.startsWith("http") ? { sourceUrl: input.slice(0, 2000) } : {}),
      });
    } catch (err) {
      if (!(err instanceof InvalidProductReferenceError)) throw err;
      errors.push(`  ✗ ${err.message}`);
    }
  }
  if (errors.length) {
    out("Nothing queued — fix these first:");
    errors.forEach((e) => out(e));
    process.exit(1);
  }

  const env = loadWorkerEnv();
  const boss = new PgBoss({
    connectionString: env.DIRECT_DATABASE_URL,
    schema: env.WORKER_PGBOSS_SCHEMA,
    supervise: false,
    schedule: false,
    application_name: "import-product-cli",
  });
  await boss.start();
  try {
    for (const job of jobs) {
      const id = await boss.send(IMPORT_FETCH_QUEUE, job, {
        singletonKey: `${IMPORT_FETCH_QUEUE}:${job.externalProductId}`,
        singletonSeconds: 300,
      });
      out(
        id
          ? `  ✓ ${job.externalProductId} queued (job ${id})`
          : `  • ${job.externalProductId} already queued in the last 5 minutes`,
      );
    }
  } finally {
    await boss.stop({ graceful: false, wait: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`import:product failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
