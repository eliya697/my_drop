/**
 * Base class for every error raised by domain logic. `code` is stable and safe to branch on,
 * log, and return to API clients; `message` is for humans.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class IllegalTransitionError<S extends string = string> extends DomainError {
  readonly code = "ILLEGAL_TRANSITION";

  constructor(
    readonly entity: string,
    readonly from: S,
    readonly to: S,
    readonly allowed: readonly S[],
  ) {
    super(
      `${entity}: illegal transition ${from} -> ${to}` +
        (allowed.length ? ` (allowed: ${allowed.join(", ")})` : ` (${from} is terminal)`),
    );
  }
}

export class UnknownStateError extends DomainError {
  readonly code = "UNKNOWN_STATE";

  constructor(
    readonly entity: string,
    readonly value: unknown,
  ) {
    super(`${entity}: unknown state ${JSON.stringify(value)}`);
  }
}

export class InvalidPricingInputError extends DomainError {
  readonly code = "INVALID_PRICING_INPUT";

  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`pricing input ${field} ${reason}`);
  }
}

export class EntityNotFoundError extends DomainError {
  readonly code = "ENTITY_NOT_FOUND";

  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
  }
}

/**
 * The record changed between the caller reading it and writing it (optimistic lock failure).
 * Callers should reload and re-decide — never blindly retry the same write.
 */
export class ConcurrentModificationError extends DomainError {
  readonly code = "CONCURRENT_MODIFICATION";

  constructor(
    readonly entity: string,
    readonly id: string,
    readonly expected: { status: string; version?: number },
    readonly actual: { status: string; version: number },
  ) {
    super(
      `${entity} ${id}: expected status ${expected.status}` +
        (expected.version !== undefined ? ` at version ${expected.version}` : "") +
        `, found ${actual.status} at version ${actual.version}`,
    );
  }
}
