/**
 * (Re-)queues AI enrichment.
 *
 *   pnpm enrich:product <product-id> [...]   products in `imported` or `enrichment_failed`
 *   pnpm enrich:product --failed             every product in `enrichment_failed`
 *   pnpm enrich:product --imported           every product still in `imported`
 *
 * Each product moves to `enriching` and gets an enrich.listing job. Products in any other status
 * are reported and left alone.
 */
import { parseArgs } from "node:util";
import { loadWorkerEnv } from "@dropship/config";
import { ConcurrentModificationError, EntityNotFoundError, type ProductStatus } from "@dropship/core";
import { createDb, productsInStatus, transitionProduct } from "@dropship/db";
import PgBoss from "pg-boss";
import { ENRICH_QUEUE } from "../jobs/enrich";

const out = (line = "") => process.stdout.write(`${line}\n`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { failed: { type: "boolean" }, imported: { type: "boolean" } },
  });
  const invalid = positionals.filter((p) => !UUID.test(p));
  if (invalid.length) throw new Error(`not product ids: ${invalid.join(", ")}`);
  if (!positionals.length && !values.failed && !values.imported) {
    out("usage: pnpm enrich:product <product-id> [...] | --failed | --imported");
    process.exit(2);
  }

  const env = loadWorkerEnv();
  if (!env.ANTHROPIC_API_KEY)
    out("warning: ANTHROPIC_API_KEY is not set; jobs will wait until the worker has it.");

  const database = createDb(env.DIRECT_DATABASE_URL, { max: 2, applicationName: "enrich-product-cli" });
  const boss = new PgBoss({
    connectionString: env.DIRECT_DATABASE_URL,
    schema: env.WORKER_PGBOSS_SCHEMA,
    supervise: false,
    schedule: false,
    application_name: "enrich-product-cli",
  });
  await boss.start();
  try {
    const ids = [...positionals];
    if (values.failed) ids.push(...(await productsInStatus(database.db, "enrichment_failed", 10_000)));
    if (values.imported) ids.push(...(await productsInStatus(database.db, "imported", 10_000)));

    let queued = 0;
    for (const id of [...new Set(ids)]) {
      const queuedFrom = await requeue(database.db, id);
      if (queuedFrom) {
        await boss.send(ENRICH_QUEUE, { productId: id });
        queued++;
        out(`  ✓ ${id} (${queuedFrom} → enriching)`);
      }
    }
    out(`${queued} product(s) queued for enrichment.`);
  } finally {
    await boss.stop({ graceful: false, wait: true });
    await database.close();
  }
}

/** Tries both legal source states; returns the one the product was in, or null. */
async function requeue(
  db: Parameters<typeof transitionProduct>[0],
  id: string,
): Promise<ProductStatus | null> {
  for (const from of ["enrichment_failed", "imported"] as const) {
    try {
      await transitionProduct(db, {
        id,
        from,
        to: "enriching",
        actor: { type: "user", id: "cli" },
        reason: "re-queued",
      });
      return from;
    } catch (err) {
      if (err instanceof EntityNotFoundError) {
        out(`  ✗ ${id}: not found`);
        return null;
      }
      if (!(err instanceof ConcurrentModificationError)) throw err;
      if (from === "imported") out(`  • ${id}: status is ${err.actual.status}; left unchanged`);
    }
  }
  return null;
}

main().catch((err: unknown) => {
  process.stderr.write(`enrich:product failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
