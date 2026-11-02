import { describe, expect, it } from "vitest";
import { fakeClock } from "../test-utils";
import { CircuitBreaker, CircuitOpenError, ConcurrencyLimiter, retry, TokenBucket } from "./resilience";

class Outage extends Error {}
class BadRequest extends Error {}

describe("TokenBucket", () => {
  it("allows a burst, then paces at the refill rate", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(3, 2, clock); // burst 3, then 2/s
    const start = clock.now();
    for (let i = 0; i < 7; i++) await bucket.take();
    // 3 immediate + 4 more at 500ms each = 2000ms
    expect(clock.now() - start).toBe(2000);
  });

  it("rejects non-positive configuration", () => {
    expect(() => new TokenBucket(0, 1)).toThrow(RangeError);
  });
});

describe("ConcurrencyLimiter", () => {
  it("never exceeds the limit", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBe(2);
  });

  it("releases its slot when a task throws", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });
});

describe("retry", () => {
  it("retries retryable failures with bounded exponential backoff", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retry(
      async () => {
        if (++calls < 4) throw new Outage();
        return "done";
      },
      {
        attempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 250,
        shouldRetry: (e) => e instanceof Outage,
        clock,
        random: () => 1,
      },
    );
    expect(result).toBe("done");
    expect(clock.sleeps).toEqual([100, 200, 250]);
  });

  it("stops immediately on a non-retryable failure", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new BadRequest();
        },
        {
          attempts: 5,
          baseDelayMs: 1,
          maxDelayMs: 1,
          shouldRetry: (e) => e instanceof Outage,
          clock: fakeClock(),
        },
      ),
    ).rejects.toBeInstanceOf(BadRequest);
    expect(calls).toBe(1);
  });

  it("gives up after the attempt budget", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Outage();
        },
        { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, shouldRetry: () => true, clock: fakeClock() },
      ),
    ).rejects.toBeInstanceOf(Outage);
    expect(calls).toBe(3);
  });

  it("honors a server-provided delay", async () => {
    const clock = fakeClock();
    let calls = 0;
    await retry(
      async () => {
        if (++calls === 1) throw new Outage();
      },
      {
        attempts: 2,
        baseDelayMs: 1,
        maxDelayMs: 1,
        shouldRetry: () => true,
        delayOverrideMs: () => 7000,
        clock,
      },
    );
    expect(clock.sleeps).toEqual([7000]);
  });
});

describe("CircuitBreaker", () => {
  const make = (clock = fakeClock()) => ({
    clock,
    breaker: new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 10_000,
      isFailure: (e) => e instanceof Outage,
      clock,
    }),
  });
  const fail = () => Promise.reject(new Outage());

  it("opens after consecutive failures and fails fast", async () => {
    const { breaker } = make();
    for (let i = 0; i < 3; i++) await expect(breaker.run(fail)).rejects.toBeInstanceOf(Outage);
    expect(breaker.currentState).toBe("open");
    let called = false;
    await expect(
      breaker.run(async () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });

  it("does not count non-outage errors", async () => {
    const { breaker } = make();
    for (let i = 0; i < 5; i++)
      await expect(breaker.run(() => Promise.reject(new BadRequest()))).rejects.toThrow();
    expect(breaker.currentState).toBe("closed");
  });

  it("resets the failure count on success", async () => {
    const { breaker } = make();
    await expect(breaker.run(fail)).rejects.toThrow();
    await expect(breaker.run(fail)).rejects.toThrow();
    await breaker.run(async () => "ok");
    await expect(breaker.run(fail)).rejects.toThrow();
    expect(breaker.currentState).toBe("closed");
  });

  it("half-opens after the cooldown and closes on a successful trial", async () => {
    const { breaker, clock } = make();
    for (let i = 0; i < 3; i++) await expect(breaker.run(fail)).rejects.toThrow();
    clock.advance(10_000);
    await expect(breaker.run(async () => "ok")).resolves.toBe("ok");
    expect(breaker.currentState).toBe("closed");
  });

  it("re-opens when the half-open trial fails", async () => {
    const { breaker, clock } = make();
    for (let i = 0; i < 3; i++) await expect(breaker.run(fail)).rejects.toThrow();
    clock.advance(10_000);
    await expect(breaker.run(fail)).rejects.toBeInstanceOf(Outage);
    expect(breaker.currentState).toBe("open");
  });
});
