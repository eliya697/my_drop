import {
  ConcurrentModificationError,
  EntityNotFoundError,
  orderMachine,
  productMachine,
  type OrderStatus,
  type ProductStatus,
  type StateMachine,
} from "@dropship/core";
import { and, eq, sql } from "drizzle-orm";
import type { Database, Transaction } from "./client";
import { auditLog, type AuditActorType } from "./schema/integration";
import { orders } from "./schema/orders";
import { products } from "./schema/catalog";

export type Actor = { type: AuditActorType; id?: string };

export const SYSTEM_ACTOR: Actor = Object.freeze({ type: "system" });

/** Anything that can open a transaction: the root client, or an open transaction (→ savepoint). */
export type Executor = Database | Transaction;

type TransitionInput<S extends string, Patch> = {
  id: string;
  from: S;
  to: S;
  actor: Actor;
  /** Why the transition happened; stored on the row and in the audit log. */
  reason?: string;
  /**
   * Version the caller read. When set, the write also fails if anything else changed the row
   * since, even if the status is still `from`.
   */
  expectedVersion?: number;
  /** Other columns to write atomically with the status change. */
  patch?: Patch;
  /** Extra structured context for the audit log entry. */
  data?: Record<string, unknown>;
};

export type TransitionResult<S extends string> = { id: string; status: S; version: number };

export type OrderPatch = Partial<
  Omit<typeof orders.$inferInsert, "id" | "number" | "status" | "version" | "statusReason" | "createdAt">
>;
export type ProductPatch = Partial<
  Omit<typeof products.$inferInsert, "id" | "status" | "version" | "createdAt" | "updatedAt">
>;

/**
 * Moves an order from `from` to `to`.
 *
 * Guarantees, all inside one transaction (a savepoint if `executor` already is one):
 *  1. the transition is legal per `orderMachine` — otherwise IllegalTransitionError, nothing written;
 *  2. the row is only updated if it is still in `from` (and at `expectedVersion`, if given) —
 *     otherwise ConcurrentModificationError with the state actually found;
 *  3. `version` is incremented and an `audit_log` row is written, or neither happens.
 *
 * Concurrency: the conditional UPDATE takes the row lock. A competing transaction blocks on it,
 * re-evaluates the WHERE clause once the winner commits, matches zero rows, and fails with
 * ConcurrentModificationError — so exactly one of N racing transitions wins.
 */
export async function transitionOrder(
  executor: Executor,
  input: TransitionInput<OrderStatus, OrderPatch>,
): Promise<TransitionResult<OrderStatus>> {
  orderMachine.assertTransition(input.from, input.to);

  return executor.transaction(async (tx) => {
    const [row] = await tx
      .update(orders)
      .set({
        ...input.patch,
        status: input.to,
        statusReason: input.reason ?? null,
        version: sql`${orders.version} + 1`,
        ...(input.to === "paid" ? { paidAt: sql`coalesce(${orders.paidAt}, now())` } : {}),
      })
      .where(
        and(
          eq(orders.id, input.id),
          eq(orders.status, input.from),
          input.expectedVersion === undefined ? undefined : eq(orders.version, input.expectedVersion),
        ),
      )
      .returning({ id: orders.id, status: orders.status, version: orders.version });

    if (!row) {
      const [current] = await tx
        .select({ status: orders.status, version: orders.version })
        .from(orders)
        .where(eq(orders.id, input.id));
      throw conflictOrMissing(orderMachine, input, current);
    }

    await writeAudit(tx, "order", row.version, input);
    return row;
  });
}

/** Moves a product from `from` to `to`. Same guarantees as {@link transitionOrder}. */
export async function transitionProduct(
  executor: Executor,
  input: TransitionInput<ProductStatus, ProductPatch>,
): Promise<TransitionResult<ProductStatus>> {
  productMachine.assertTransition(input.from, input.to);

  return executor.transaction(async (tx) => {
    const [row] = await tx
      .update(products)
      .set({
        ...input.patch,
        status: input.to,
        version: sql`${products.version} + 1`,
        // First publication date is kept across pause/unpause cycles.
        ...(input.to === "published" ? { publishedAt: sql`coalesce(${products.publishedAt}, now())` } : {}),
      })
      .where(
        and(
          eq(products.id, input.id),
          eq(products.status, input.from),
          input.expectedVersion === undefined ? undefined : eq(products.version, input.expectedVersion),
        ),
      )
      .returning({ id: products.id, status: products.status, version: products.version });

    if (!row) {
      const [current] = await tx
        .select({ status: products.status, version: products.version })
        .from(products)
        .where(eq(products.id, input.id));
      throw conflictOrMissing(productMachine, input, current);
    }

    await writeAudit(tx, "product", row.version, input);
    return row;
  });
}

function conflictOrMissing<S extends string>(
  machine: StateMachine<S>,
  input: TransitionInput<S, unknown>,
  current: { status: S; version: number } | undefined,
): Error {
  if (!current) return new EntityNotFoundError(machine.entity, input.id);
  return new ConcurrentModificationError(
    machine.entity,
    input.id,
    {
      status: input.from,
      ...(input.expectedVersion === undefined ? {} : { version: input.expectedVersion }),
    },
    current,
  );
}

async function writeAudit(
  tx: Transaction,
  entityType: "order" | "product",
  version: number,
  input: TransitionInput<string, unknown>,
) {
  await tx.insert(auditLog).values({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    entityType,
    entityId: input.id,
    action: `${entityType}.transition`,
    fromState: input.from,
    toState: input.to,
    data: {
      version,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.patch ? { patchedFields: Object.keys(input.patch).sort() } : {}),
      ...input.data,
    },
  });
}
