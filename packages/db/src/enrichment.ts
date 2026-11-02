import type { ProductStatus, SupplierProduct } from "@dropship/core";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { aiBatches, aiGenerations, type AiBatchStatus, type AiGenerationStatus } from "./schema/ai";
import { products, productVariants, supplierProducts } from "./schema/catalog";
import type { Executor } from "./transitions";

export type EnrichmentSource = {
  productId: string;
  status: ProductStatus;
  product: Omit<SupplierProduct, "raw">;
  /** Widest delivery window across active variants, or null when nothing ships yet. */
  shippingDays: { min: number; max: number } | null;
};

/** Everything the listing prompt needs, from the latest normalized snapshot. */
export async function loadEnrichmentSource(
  db: Executor,
  productId: string,
): Promise<EnrichmentSource | null> {
  const [row] = await db
    .select({ status: products.status, normalized: supplierProducts.normalized })
    .from(products)
    .innerJoin(supplierProducts, eq(supplierProducts.id, products.latestSnapshotId))
    .where(eq(products.id, productId));
  if (!row) return null;
  if (!row.normalized) throw new Error(`product ${productId} has no normalized snapshot; re-import it`);

  const [window] = await db
    .select({
      min: sql<number | null>`min(${productVariants.shippingDaysMin})`,
      max: sql<number | null>`max(${productVariants.shippingDaysMax})`,
    })
    .from(productVariants)
    .where(and(eq(productVariants.productId, productId), eq(productVariants.isActive, true)));

  return {
    productId,
    status: row.status,
    product: row.normalized as Omit<SupplierProduct, "raw">,
    shippingDays:
      window && window.min !== null && window.max !== null
        ? { min: Number(window.min), max: Number(window.max) }
        : null,
  };
}

export type GenerationRecord = {
  task: (typeof aiGenerations.$inferInsert)["task"];
  subjectType: string;
  subjectId: string;
  model: string;
  promptVersion: string;
  inputHash: string;
  status: AiGenerationStatus;
  output?: unknown;
  error?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  costUsdMicros: number;
  latencyMs?: number | null;
  fallbackUsed?: boolean;
  batch?: boolean;
};

/** Every model call is recorded, successful or not — this is the cost and quality ledger. */
export async function recordGeneration(db: Executor, record: GenerationRecord): Promise<string> {
  const [row] = await db
    .insert(aiGenerations)
    .values({
      ...record,
      output: record.output ?? null,
      error: record.error ? record.error.slice(0, 4000) : null,
    })
    .returning({ id: aiGenerations.id });
  return row!.id;
}

/** A previous successful generation for the identical input (same prompt version and model). */
export async function findReusableGeneration(
  db: Executor,
  task: GenerationRecord["task"],
  inputHash: string,
): Promise<{ id: string; output: unknown } | null> {
  const [row] = await db
    .select({ id: aiGenerations.id, output: aiGenerations.output })
    .from(aiGenerations)
    .where(
      and(
        eq(aiGenerations.task, task),
        eq(aiGenerations.inputHash, inputHash),
        eq(aiGenerations.status, "ok"),
      ),
    )
    .orderBy(desc(aiGenerations.createdAt))
    .limit(1);
  return row ?? null;
}

/** Model spend since `since` (default: start of the current UTC day), in micro-dollars. */
export async function aiSpendMicros(db: Executor, since?: Date): Promise<number> {
  const from = since ?? new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const [row] = await db
    .select({ total: sql<string | null>`sum(${aiGenerations.costUsdMicros})` })
    .from(aiGenerations)
    .where(gte(aiGenerations.createdAt, from));
  return Number(row?.total ?? 0);
}

/**
 * `base` if no other product uses it, otherwise `base-<first 6 chars of the product id>`.
 * Deterministic, so a retry produces the same slug.
 */
export async function availableSlug(db: Executor, base: string, productId: string): Promise<string> {
  const taken = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.slug, base), ne(products.id, productId)))
    .limit(1);
  if (taken.length === 0) return base;
  return `${base.slice(0, 52)}-${productId.replace(/-/g, "").slice(0, 6)}`;
}

// ---- Batches ------------------------------------------------------------------------------

export async function recordBatch(
  db: Executor,
  batch: { providerBatchId: string; task: GenerationRecord["task"]; subjectIds: string[] },
): Promise<string> {
  const [row] = await db
    .insert(aiBatches)
    .values({ ...batch, itemCount: batch.subjectIds.length })
    .returning({ id: aiBatches.id });
  return row!.id;
}

export async function openBatches(db: Executor) {
  return db.select().from(aiBatches).where(eq(aiBatches.status, "submitted")).orderBy(aiBatches.submittedAt);
}

export async function closeBatch(
  db: Executor,
  id: string,
  status: Exclude<AiBatchStatus, "submitted">,
  error?: string,
) {
  await db
    .update(aiBatches)
    .set({ status, endedAt: new Date(), error: error ?? null })
    .where(eq(aiBatches.id, id));
}

/** Products waiting for enrichment, oldest first. */
export async function productsInStatus(
  db: Executor,
  status: ProductStatus,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.status, status))
    .orderBy(products.createdAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Subset of `ids` currently in a pending batch (to avoid submitting a product twice). */
export async function idsInOpenBatches(db: Executor, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ ids: aiBatches.subjectIds })
    .from(aiBatches)
    .where(and(eq(aiBatches.status, "submitted"), sql`${aiBatches.subjectIds} && ${sql.param(ids)}::uuid[]`));
  const open = new Set(rows.flatMap((r) => r.ids));
  return new Set(ids.filter((id) => open.has(id)));
}
