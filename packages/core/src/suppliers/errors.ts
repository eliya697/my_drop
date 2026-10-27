import { DomainError } from "../errors";

/**
 * Supplier failures, classified by what the caller should do. Job handlers rethrow `retryable`
 * errors (pg-boss retries with backoff) and route everything else to manual review.
 */
export abstract class SupplierError extends DomainError {
  abstract readonly retryable: boolean;

  constructor(
    readonly supplier: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${supplier}: ${message}`);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Network failure, timeout, or 5xx. */
export class SupplierUnavailableError extends SupplierError {
  readonly code = "SUPPLIER_UNAVAILABLE";
  readonly retryable = true;
}

export class SupplierRateLimitError extends SupplierError {
  readonly code = "SUPPLIER_RATE_LIMITED";
  readonly retryable = true;

  constructor(
    supplier: string,
    readonly retryAfterMs: number | null,
    options?: { cause?: unknown },
  ) {
    super(supplier, "rate limited", options);
  }
}

/** Access token expired or revoked. Refresh the token; do not blindly retry. */
export class SupplierAuthError extends SupplierError {
  readonly code = "SUPPLIER_AUTH";
  readonly retryable = false;
}

export class SupplierNotFoundError extends SupplierError {
  readonly code = "SUPPLIER_NOT_FOUND";
  readonly retryable = false;

  constructor(
    supplier: string,
    readonly resource: "product" | "sku" | "order",
    readonly id: string,
  ) {
    super(supplier, `${resource} ${id} not found`);
  }
}

export class SupplierOutOfStockError extends SupplierError {
  readonly code = "SUPPLIER_OUT_OF_STOCK";
  readonly retryable = false;

  constructor(
    supplier: string,
    readonly skuId: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(supplier, `sku ${skuId}: requested ${requested}, available ${available}`);
  }
}

/** The supplier rejected our request (bad address, unsupported shipping method, ...). */
export class SupplierRejectedError extends SupplierError {
  readonly code = "SUPPLIER_REJECTED";
  readonly retryable = false;

  constructor(
    supplier: string,
    readonly supplierCode: string,
    message: string,
  ) {
    super(supplier, `${supplierCode}: ${message}`);
  }
}

/** No variant/shipping combination satisfied the query's constraints. */
export class NoEligibleVariantError extends SupplierError {
  readonly code = "NO_ELIGIBLE_VARIANT";
  readonly retryable = false;
}

export const isRetryableSupplierError = (err: unknown): boolean =>
  err instanceof SupplierError && err.retryable;
