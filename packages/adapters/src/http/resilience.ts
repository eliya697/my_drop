/**
 * Small, dependency-free resilience primitives with injectable clocks so they can be tested
 * deterministically. Shared by every outbound integration.
 */

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Token bucket: allows bursts up to `capacity`, refills at `refillPerSecond`. `take()` waits
 * until a token is available. Waiters are served in FIFO order.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: Clock = realClock,
  ) {
    if (capacity <= 0 || refillPerSecond <= 0)
      throw new RangeError("capacity and refill rate must be positive");
    this.tokens = capacity;
    this.last = clock.now();
  }

  take(): Promise<void> {
    const next = this.queue.then(() => this.acquire());
    this.queue = next.catch(() => {});
    return next;
  }

  private async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.clock.sleep(Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000));
    }
  }

  private refill() {
    const now = this.clock.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSecond);
    this.last = now;
  }
}

/** Caps the number of in-flight operations. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (max <= 0) throw new RangeError("max must be positive");
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor(readonly retryInMs: number) {
    super(`circuit open; retry in ${retryInMs}ms`);
    this.name = "CircuitOpenError";
  }
}

/**
 * Opens after `failureThreshold` consecutive failures and rejects calls immediately for
 * `cooldownMs`. Then allows a single trial call (half-open): success closes it, failure re-opens.
 * Only failures for which `isFailure(err)` is true count — a 404 is not an outage.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    private readonly opts: {
      failureThreshold: number;
      cooldownMs: number;
      isFailure: (err: unknown) => boolean;
      clock?: Clock;
      onStateChange?: (state: CircuitState) => void;
    },
  ) {}

  get currentState(): CircuitState {
    return this.state;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const clock = this.opts.clock ?? realClock;
    if (this.state === "open") {
      const elapsed = clock.now() - this.openedAt;
      if (elapsed < this.opts.cooldownMs) throw new CircuitOpenError(this.opts.cooldownMs - elapsed);
      this.transition("half_open");
    }
    if (this.state === "half_open") {
      if (this.trialInFlight) throw new CircuitOpenError(this.opts.cooldownMs);
      this.trialInFlight = true;
    }

    try {
      const result = await fn();
      this.failures = 0;
      if (this.state !== "closed") this.transition("closed");
      return result;
    } catch (err) {
      if (this.opts.isFailure(err)) {
        this.failures++;
        if (this.state === "half_open" || this.failures >= this.opts.failureThreshold) {
          this.openedAt = clock.now();
          this.transition("open");
        }
      } else if (this.state === "half_open") {
        // The service answered (e.g. a 4xx): it is up.
        this.failures = 0;
        this.transition("closed");
      }
      throw err;
    } finally {
      this.trialInFlight = false;
    }
  }

  private transition(state: CircuitState) {
    this.state = state;
    this.opts.onStateChange?.(state);
  }
}

export type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (err: unknown) => boolean;
  /** Server-provided delay (e.g. Retry-After) that overrides the computed backoff. */
  delayOverrideMs?: (err: unknown) => number | null;
  clock?: Clock;
  random?: () => number;
};

/** Exponential backoff with full jitter. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const clock = opts.clock ?? realClock;
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.attempts || !opts.shouldRetry(err)) throw err;
      const override = opts.delayOverrideMs?.(err) ?? null;
      const ceiling = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
      await clock.sleep(override ?? Math.round(random() * ceiling));
    }
  }
}
