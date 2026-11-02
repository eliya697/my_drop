import { SupplierError, SupplierRateLimitError, SupplierUnavailableError } from "@dropship/core";
import {
  CircuitBreaker,
  CircuitOpenError,
  ConcurrencyLimiter,
  realClock,
  retry,
  TokenBucket,
  type CircuitState,
  type Clock,
} from "../http/resilience";
import { classifyGatewayError, SUPPLIER } from "./errors";
import { signRequest } from "./sign";

export const DEFAULT_GATEWAY = "https://api-sg.aliexpress.com";

export type AliExpressClientOptions = {
  appKey: string;
  appSecret: string;
  gateway?: string;
  /** Sustained requests per second (token bucket refill). Match the app's quota. */
  requestsPerSecond?: number;
  /** Burst size. */
  burst?: number;
  maxConcurrency?: number;
  timeoutMs?: number;
  /** Total attempts per call, including the first. */
  attempts?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  fetch?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  onCircuitStateChange?: (state: CircuitState) => void;
};

export type JsonObject = Record<string, unknown>;

type Call = { kind: "business"; method: string } | { kind: "system"; path: string };

/**
 * Low-level client for the AliExpress Open Platform gateway. Signs every request, enforces a
 * client-side rate limit and concurrency cap, retries transient failures with jittered backoff,
 * and trips a circuit breaker on sustained outages. Every failure surfaces as a `SupplierError`.
 *
 *   business APIs:  POST {gateway}/sync   (method=<api name> is a signed parameter)
 *   system APIs:    POST {gateway}/rest{path}   (path is prefixed to the signed string)
 */
export class AliExpressClient {
  private readonly bucket: TokenBucket;
  private readonly limiter: ConcurrencyLimiter;
  private readonly breaker: CircuitBreaker;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly gateway: string;

  constructor(private readonly opts: AliExpressClientOptions) {
    if (!opts.appKey || !opts.appSecret) throw new Error("AliExpress appKey and appSecret are required");
    this.clock = opts.clock ?? realClock;
    this.fetchImpl = opts.fetch ?? fetch;
    this.gateway = (opts.gateway ?? DEFAULT_GATEWAY).replace(/\/+$/, "");
    this.bucket = new TokenBucket(opts.burst ?? 10, opts.requestsPerSecond ?? 10, this.clock);
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrency ?? 5);
    this.breaker = new CircuitBreaker({
      failureThreshold: opts.circuitFailureThreshold ?? 5,
      cooldownMs: opts.circuitCooldownMs ?? 60_000,
      isFailure: (err) => err instanceof SupplierUnavailableError,
      clock: this.clock,
      onStateChange: opts.onCircuitStateChange,
    });
  }

  get circuitState(): CircuitState {
    return this.breaker.currentState;
  }

  /** Calls a business API such as `aliexpress.ds.product.get`. */
  business<T = JsonObject>(
    method: string,
    params: Record<string, string>,
    ctx: { accessToken: string; resourceId?: string },
  ): Promise<T> {
    return this.call<T>(
      { kind: "business", method },
      { ...params, access_token: ctx.accessToken },
      ctx.resourceId,
    );
  }

  /** Calls a system API such as `/auth/token/create` (no access token). */
  system<T = JsonObject>(path: string, params: Record<string, string>): Promise<T> {
    return this.call<T>({ kind: "system", path }, params);
  }

  private async call<T>(target: Call, params: Record<string, string>, resourceId?: string): Promise<T> {
    try {
      return await this.breaker.run(() =>
        retry(
          () =>
            this.limiter.run(async () => {
              await this.bucket.take();
              return this.send<T>(target, params, resourceId);
            }),
          {
            attempts: this.opts.attempts ?? 4,
            baseDelayMs: 500,
            maxDelayMs: 10_000,
            shouldRetry: (err) => err instanceof SupplierError && err.retryable,
            delayOverrideMs: (err) => (err instanceof SupplierRateLimitError ? err.retryAfterMs : null),
            clock: this.clock,
            random: this.opts.random,
          },
        ),
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        throw new SupplierUnavailableError(SUPPLIER, `circuit open, retry in ${err.retryInMs}ms`, {
          cause: err,
        });
      }
      throw err;
    }
  }

  private async send<T>(target: Call, extra: Record<string, string>, resourceId?: string): Promise<T> {
    const params: Record<string, string> = {
      ...extra,
      app_key: this.opts.appKey,
      timestamp: String(this.clock.now()),
      sign_method: "sha256",
      ...(target.kind === "business" ? { method: target.method } : {}),
    };
    params.sign = signRequest(
      params,
      this.opts.appSecret,
      target.kind === "system" ? target.path : undefined,
    );

    const url = target.kind === "business" ? `${this.gateway}/sync` : `${this.gateway}/rest${target.path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new SupplierUnavailableError(SUPPLIER, `network error: ${(err as Error).message}`, {
        cause: err,
      });
    }

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new SupplierRateLimitError(
        SUPPLIER,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
      );
    }
    if (response.status >= 500) throw new SupplierUnavailableError(SUPPLIER, `HTTP ${response.status}`);

    let body: JsonObject;
    try {
      body = (await response.json()) as JsonObject;
    } catch (err) {
      throw new SupplierUnavailableError(SUPPLIER, `invalid JSON (HTTP ${response.status})`, { cause: err });
    }

    const failure = extractGatewayError(body);
    if (failure) throw classifyGatewayError(failure, { resourceId });
    if (!response.ok) throw new SupplierUnavailableError(SUPPLIER, `HTTP ${response.status}`);
    return body as T;
  }
}

/** Finds an error in any of the envelope shapes the gateway uses. */
export function extractGatewayError(
  body: JsonObject,
): { code: string; type?: string; message?: string; requestId?: string } | null {
  const legacy = body.error_response as JsonObject | undefined;
  if (legacy && typeof legacy === "object") {
    return {
      code: String(legacy.code ?? "unknown"),
      type: str(legacy.type),
      message: str(legacy.msg) ?? str(legacy.message) ?? str(legacy.sub_msg),
      requestId: str(legacy.request_id),
    };
  }
  const code = body.code;
  if (code !== undefined && code !== null && String(code) !== "0") {
    return {
      code: String(code),
      type: str(body.type),
      message: str(body.message) ?? str(body.msg),
      requestId: str(body.request_id),
    };
  }
  return null;
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));
