import { Writable } from "node:stream";
import { IllegalTransitionError, SupplierRejectedError, SupplierUnavailableError } from "@dropship/core";
import { createLogger } from "@dropship/logger";
import type PgBoss from "pg-boss";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEAD_LETTER_QUEUE } from "./queues";
import { isPermanent, PermanentJobError, registerJob } from "./run";

const logger = createLogger({
  service: "test",
  level: "silent",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

/** Captures the registered handler and every send(), standing in for pg-boss. */
function fakeBoss() {
  let handler:
    | ((jobs: { id: string; data: unknown; retryCount: number; retryLimit: number }[]) => Promise<void>)
    | undefined;
  const sent: { queue: string; data: unknown }[] = [];
  const boss = {
    work: async (_q: string, _o: unknown, h: typeof handler) => {
      handler = h;
      return "worker-id";
    },
    send: async (queue: string, data: unknown) => {
      sent.push({ queue, data });
      return "job-id";
    },
  } as unknown as PgBoss;
  return {
    boss,
    sent,
    run: (data: unknown, retryCount = 0, retryLimit = 3) =>
      handler!([{ id: "job-1", data, retryCount, retryLimit }]),
  };
}

describe("isPermanent", () => {
  it.each([
    [new PermanentJobError("X", "bad"), true],
    [new SupplierRejectedError("ae", "C", "no"), true],
    [new IllegalTransitionError("order", "paid", "cancelled", []), true],
    [new z.ZodError([]), true],
    [new SupplierUnavailableError("ae", "down"), false],
    [new Error("unknown"), false],
    [Object.assign(new Error("img"), { retryable: false }), true],
  ])("%s → %s", (err, expected) => {
    expect(isPermanent(err)).toBe(expected);
  });
});

describe("registerJob", () => {
  const schema = z.object({ id: z.string() });

  it("validates data and runs the handler", async () => {
    const { boss, run, sent } = fakeBoss();
    const seen: unknown[] = [];
    await registerJob(boss, "import.fetch", schema, async (data) => void seen.push(data), { logger });
    await run({ id: "a" });
    expect(seen).toEqual([{ id: "a" }]);
    expect(sent).toEqual([]);
  });

  it("sends invalid data to the dead-letter queue instead of retrying", async () => {
    const { boss, run, sent } = fakeBoss();
    await registerJob(boss, "import.fetch", schema, async () => undefined, { logger });
    await expect(run({ id: 42 })).resolves.toBeUndefined();
    expect(sent[0]).toMatchObject({
      queue: DEAD_LETTER_QUEUE,
      data: { queue: "import.fetch", jobId: "job-1", error: { name: "ZodError" } },
    });
  });

  it("dead-letters permanent failures with their error code", async () => {
    const { boss, run, sent } = fakeBoss();
    await registerJob(
      boss,
      "import.fetch",
      schema,
      async () => {
        throw new SupplierRejectedError("aliexpress", "PRODUCT_UNAVAILABLE", "not on sale");
      },
      { logger },
    );
    await run({ id: "a" });
    expect(sent[0]!.data).toMatchObject({ error: { code: "SUPPLIER_REJECTED" } });
  });

  it("tells the handler when it is on its final attempt", async () => {
    const { boss, run } = fakeBoss();
    const seen: boolean[] = [];
    await registerJob(boss, "import.fetch", schema, async (_d, ctx) => void seen.push(ctx.isFinalAttempt), {
      logger,
    });
    await run({ id: "a" }, 0, 3);
    await run({ id: "a" }, 3, 3);
    expect(seen).toEqual([false, true]);
  });

  it("rethrows transient failures so pg-boss retries them", async () => {
    const { boss, run, sent } = fakeBoss();
    await registerJob(
      boss,
      "import.fetch",
      schema,
      async () => {
        throw new SupplierUnavailableError("aliexpress", "timeout");
      },
      { logger },
    );
    await expect(run({ id: "a" })).rejects.toBeInstanceOf(SupplierUnavailableError);
    expect(sent).toEqual([]);
  });
});
