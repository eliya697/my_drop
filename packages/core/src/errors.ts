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
