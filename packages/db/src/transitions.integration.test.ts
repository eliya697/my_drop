import { randomUUID } from "node:crypto";
import { ConcurrentModificationError, EntityNotFoundError, IllegalTransitionError } from "@dropship/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client";
import { runMigrations } from "./migrate";
import { auditLog, orders, products } from "./schema/index";
import { SYSTEM_ACTOR, transitionOrder, transitionProduct, type Actor } from "./transitions";

/** Runs against a real Postgres; set TEST_DATABASE_URL to enable (see schema.integration.test.ts). */
const url = process.env.TEST_DATABASE_URL;

const WEBHOOK: Actor = { type: "webhook", id: "evt_test_123" };

describe.skipIf(!url)("state transitions (integration)", () => {
  let handle: DbHandle;

  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!, { max: 6, applicationName: "transitions-test" });
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function newOrder(status: (typeof orders.$inferInsert)["status"] = "pending_payment") {
    const [row] = await handle.db
      .insert(orders)
      .values({
        email: `${randomUUID()}@example.com`,
        status,
        subtotalMinor: 9990,
        vatMinor: 1524,
        totalMinor: 9990,
        shippingAddress: {
          fullName: "Dana",
          phone: "+972500000000",
          line1: "Herzl 1",
          city: "Tel Aviv",
          country: "IL",
        },
      })
      .returning({ id: orders.id });
    return row!.id;
  }

  async function newProduct(status: (typeof products.$inferInsert)["status"] = "pending_review") {
    const [row] = await handle.db
      .insert(products)
      .values({ externalId: `ext-${randomUUID()}`, status })
      .returning({ id: products.id });
    return row!.id;
  }

  const loadOrder = async (id: string) =>
    (await handle.db.select().from(orders).where(eq(orders.id, id)))[0]!;
  const loadProduct = async (id: string) =>
    (await handle.db.select().from(products).where(eq(products.id, id)))[0]!;
  const auditFor = (id: string) =>
    handle.db.select().from(auditLog).where(eq(auditLog.entityId, id)).orderBy(auditLog.id);

  describe("transitionOrder", () => {
    it("updates status and version, sets paid_at, and writes one audit row", async () => {
      const id = await newOrder();
      const result = await transitionOrder(handle.db, {
        id,
        from: "pending_payment",
        to: "paid",
        actor: WEBHOOK,
        reason: "checkout.session.completed",
        patch: { stripePaymentIntent: `pi_${id}` },
      });

      expect(result).toEqual({ id, status: "paid", version: 1 });
      const order = await loadOrder(id);
      expect(order.status).toBe("paid");
      expect(order.version).toBe(1);
      expect(order.statusReason).toBe("checkout.session.completed");
      expect(order.stripePaymentIntent).toBe(`pi_${id}`);
      expect(order.paidAt).toBeInstanceOf(Date);

      const audit = await auditFor(id);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorType: "webhook",
        actorId: "evt_test_123",
        entityType: "order",
        action: "order.transition",
        fromState: "pending_payment",
        toState: "paid",
        data: { version: 1, reason: "checkout.session.completed", patchedFields: ["stripePaymentIntent"] },
      });
    });

    it("records a full history across successive transitions", async () => {
      const id = await newOrder();
      await transitionOrder(handle.db, { id, from: "pending_payment", to: "paid", actor: WEBHOOK });
      await transitionOrder(handle.db, { id, from: "paid", to: "fulfillment_queued", actor: SYSTEM_ACTOR });
      const last = await transitionOrder(handle.db, {
        id,
        from: "fulfillment_queued",
        to: "placed_with_supplier",
        actor: SYSTEM_ACTOR,
        expectedVersion: 2,
      });

      expect(last.version).toBe(3);
      const audit = await auditFor(id);
      expect(audit.map((a) => [a.fromState, a.toState])).toEqual([
        ["pending_payment", "paid"],
        ["paid", "fulfillment_queued"],
        ["fulfillment_queued", "placed_with_supplier"],
      ]);
      // statusReason belongs to the latest transition only
      expect((await loadOrder(id)).statusReason).toBeNull();
    });

    it("rejects an illegal transition before touching the database", async () => {
      const id = await newOrder("paid");
      await expect(
        transitionOrder(handle.db, { id, from: "paid", to: "cancelled", actor: SYSTEM_ACTOR }),
      ).rejects.toBeInstanceOf(IllegalTransitionError);
      expect((await loadOrder(id)).status).toBe("paid");
      expect(await auditFor(id)).toHaveLength(0);
    });

    it("fails with the actual state when the row is no longer in `from`", async () => {
      const id = await newOrder("paid");
      const err = await transitionOrder(handle.db, {
        id,
        from: "pending_payment",
        to: "paid",
        actor: WEBHOOK,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConcurrentModificationError);
      expect(err).toMatchObject({
        code: "CONCURRENT_MODIFICATION",
        entity: "order",
        id,
        expected: { status: "pending_payment" },
        actual: { status: "paid", version: 0 },
      });
      expect(await auditFor(id)).toHaveLength(0);
    });

    it("fails when the version moved on even though the status matches", async () => {
      const id = await newOrder();
      await handle.db.update(orders).set({ version: 5 }).where(eq(orders.id, id));
      await expect(
        transitionOrder(handle.db, {
          id,
          from: "pending_payment",
          to: "paid",
          actor: WEBHOOK,
          expectedVersion: 4,
        }),
      ).rejects.toMatchObject({
        actual: { status: "pending_payment", version: 5 },
        expected: { version: 4 },
      });
      expect((await loadOrder(id)).status).toBe("pending_payment");
    });

    it("reports a missing order as EntityNotFoundError", async () => {
      await expect(
        transitionOrder(handle.db, { id: randomUUID(), from: "pending_payment", to: "paid", actor: WEBHOOK }),
      ).rejects.toBeInstanceOf(EntityNotFoundError);
    });

    it("lets exactly one of many concurrent identical transitions win", async () => {
      const id = await newOrder();
      // Simulates Stripe delivering the same webhook several times in parallel.
      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          handle.db.transaction(async (tx) => {
            const result = await transitionOrder(tx, {
              id,
              from: "pending_payment",
              to: "paid",
              actor: WEBHOOK,
            });
            // Hold the row lock briefly so the others queue up behind it.
            await tx.execute("select pg_sleep(0.05)");
            return result;
          }),
        ),
      );

      const won = attempts.filter((a) => a.status === "fulfilled");
      const lost = attempts.filter((a): a is PromiseRejectedResult => a.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(4);
      for (const l of lost) expect(l.reason).toBeInstanceOf(ConcurrentModificationError);

      const order = await loadOrder(id);
      expect(order.status).toBe("paid");
      expect(order.version).toBe(1);
      expect(await auditFor(id)).toHaveLength(1);
    });

    it("resolves a race between conflicting transitions to a single outcome", async () => {
      const id = await newOrder();
      const [pay, cancel] = await Promise.allSettled([
        transitionOrder(handle.db, { id, from: "pending_payment", to: "paid", actor: WEBHOOK }),
        transitionOrder(handle.db, { id, from: "pending_payment", to: "cancelled", actor: SYSTEM_ACTOR }),
      ]);

      expect([pay.status, cancel.status].sort()).toEqual(["fulfilled", "rejected"]);
      const order = await loadOrder(id);
      const audit = await auditFor(id);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.toState).toBe(order.status);
    });

    it("rolls back the status change and audit row with the caller's transaction", async () => {
      const id = await newOrder();
      class Abort extends Error {}
      await handle.db
        .transaction(async (tx) => {
          await transitionOrder(tx, { id, from: "pending_payment", to: "paid", actor: WEBHOOK });
          throw new Abort();
        })
        .catch((e: unknown) => {
          if (!(e instanceof Abort)) throw e;
        });

      const order = await loadOrder(id);
      expect(order.status).toBe("pending_payment");
      expect(order.version).toBe(0);
      expect(order.paidAt).toBeNull();
      expect(await auditFor(id)).toHaveLength(0);
    });

    it("leaves the caller's transaction usable after a failed transition (savepoint)", async () => {
      const id = await newOrder();
      const other = await newOrder();
      await handle.db.transaction(async (tx) => {
        await expect(
          transitionOrder(tx, { id: randomUUID(), from: "pending_payment", to: "paid", actor: WEBHOOK }),
        ).rejects.toBeInstanceOf(EntityNotFoundError);
        await transitionOrder(tx, { id, from: "pending_payment", to: "paid", actor: WEBHOOK });
        await transitionOrder(tx, {
          id: other,
          from: "pending_payment",
          to: "cancelled",
          actor: SYSTEM_ACTOR,
        });
      });
      expect((await loadOrder(id)).status).toBe("paid");
      expect((await loadOrder(other)).status).toBe("cancelled");
    });

    it("keeps the original paid_at if an order is somehow paid again", async () => {
      const id = await newOrder();
      const firstPaidAt = new Date("2026-01-01T00:00:00Z");
      await handle.db.update(orders).set({ paidAt: firstPaidAt }).where(eq(orders.id, id));
      await transitionOrder(handle.db, { id, from: "pending_payment", to: "paid", actor: WEBHOOK });
      expect((await loadOrder(id)).paidAt?.toISOString()).toBe(firstPaidAt.toISOString());
    });
  });

  describe("transitionProduct", () => {
    it("publishes, stamps published_at once, and keeps it across pause cycles", async () => {
      const id = await newProduct();
      const admin: Actor = { type: "user", id: randomUUID() };

      await transitionProduct(handle.db, { id, from: "pending_review", to: "published", actor: admin });
      const firstPublishedAt = (await loadProduct(id)).publishedAt;
      expect(firstPublishedAt).toBeInstanceOf(Date);

      await transitionProduct(handle.db, {
        id,
        from: "published",
        to: "paused",
        actor: SYSTEM_ACTOR,
        reason: "price jump",
      });
      await transitionProduct(handle.db, { id, from: "paused", to: "published", actor: admin });

      const product = await loadProduct(id);
      expect(product.status).toBe("published");
      expect(product.version).toBe(3);
      expect(product.publishedAt?.toISOString()).toBe(firstPublishedAt?.toISOString());

      const audit = await handle.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, id), eq(auditLog.entityType, "product")))
        .orderBy(auditLog.id);
      expect(audit.map((a) => a.toState)).toEqual(["published", "paused", "published"]);
      expect(audit[0]).toMatchObject({ actorType: "user", actorId: admin.id, action: "product.transition" });
      expect(audit[1]!.data).toMatchObject({ reason: "price jump" });
    });

    it("writes patched columns atomically with the status change", async () => {
      const id = await newProduct("enriching");
      await transitionProduct(handle.db, {
        id,
        from: "enriching",
        to: "pending_review",
        actor: { type: "ai" },
        patch: { title: "מנורת לילה", positioning: "standard", riskFlags: ["battery_or_hazmat"] },
      });
      const product = await loadProduct(id);
      expect(product).toMatchObject({
        status: "pending_review",
        title: "מנורת לילה",
        positioning: "standard",
        riskFlags: ["battery_or_hazmat"],
      });
      expect(product.updatedAt.getTime()).toBeGreaterThanOrEqual(product.createdAt.getTime());
    });

    it("refuses to publish without review", async () => {
      const id = await newProduct("imported");
      await expect(
        transitionProduct(handle.db, { id, from: "imported", to: "published", actor: SYSTEM_ACTOR }),
      ).rejects.toBeInstanceOf(IllegalTransitionError);
      expect((await loadProduct(id)).status).toBe("imported");
    });

    it("rolls back the status change when a patch violates a constraint", async () => {
      const id = await newProduct("enriching");
      await expect(
        transitionProduct(handle.db, {
          id,
          from: "enriching",
          to: "pending_review",
          actor: { type: "ai" },
          patch: { positioning: "luxury" as never },
        }),
      ).rejects.toThrow();
      const product = await loadProduct(id);
      expect(product.status).toBe("enriching");
      expect(product.version).toBe(0);
      expect(await auditFor(id)).toHaveLength(0);
    });

    it("detects a concurrent change via expectedVersion", async () => {
      const id = await newProduct("published");
      await transitionProduct(handle.db, { id, from: "published", to: "paused", actor: SYSTEM_ACTOR });
      await transitionProduct(handle.db, { id, from: "paused", to: "published", actor: SYSTEM_ACTOR });
      // A stale admin screen loaded the product at version 0 while it was published.
      await expect(
        transitionProduct(handle.db, {
          id,
          from: "published",
          to: "archived",
          actor: { type: "user", id: "admin-1" },
          expectedVersion: 0,
        }),
      ).rejects.toMatchObject({
        code: "CONCURRENT_MODIFICATION",
        actual: { status: "published", version: 2 },
      });
    });
  });
});
