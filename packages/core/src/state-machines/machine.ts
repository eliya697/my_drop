import { IllegalTransitionError, UnknownStateError } from "../errors";

export type TransitionTable<S extends string> = { readonly [K in S]: readonly S[] };

export type StateMachine<S extends string> = {
  readonly entity: string;
  readonly states: readonly S[];
  readonly initial: S;
  /** States with no outgoing transitions. */
  readonly terminal: readonly S[];
  isState(value: unknown): value is S;
  /** Narrows an untrusted value (DB row, request body) to a state, or throws UnknownStateError. */
  parseState(value: unknown): S;
  canTransition(from: S, to: S): boolean;
  /** Throws IllegalTransitionError unless `from -> to` is in the table. */
  assertTransition(from: S, to: S): void;
  nextStates(from: S): readonly S[];
  isTerminal(state: S): boolean;
};

/**
 * Builds an immutable state machine from an explicit transition table. Self-transitions are
 * never legal: re-applying the current state is a no-op the caller must detect, not a transition.
 */
export function defineStateMachine<S extends string>(definition: {
  entity: string;
  states: readonly S[];
  initial: S;
  transitions: TransitionTable<S>;
}): StateMachine<S> {
  const { entity, states, initial, transitions } = definition;
  const known = new Set<string>(states);

  for (const [from, targets] of Object.entries(transitions) as [S, readonly S[]][]) {
    if (!known.has(from)) throw new Error(`${entity}: transition table has unknown state ${from}`);
    for (const to of targets) {
      if (!known.has(to)) throw new Error(`${entity}: ${from} -> unknown state ${to}`);
      if (to === from) throw new Error(`${entity}: self-transition ${from} -> ${from} is not allowed`);
    }
  }
  for (const state of states) {
    if (!(state in transitions)) throw new Error(`${entity}: state ${state} missing from transition table`);
  }

  const allowed = new Map<S, ReadonlySet<S>>(states.map((s) => [s, new Set(transitions[s])]));
  const frozenTargets = new Map<S, readonly S[]>(states.map((s) => [s, Object.freeze([...transitions[s]])]));

  const isState = (value: unknown): value is S => typeof value === "string" && known.has(value);

  return Object.freeze({
    entity,
    states: Object.freeze([...states]),
    initial,
    terminal: Object.freeze(states.filter((s) => transitions[s].length === 0)),
    isState,
    parseState(value: unknown): S {
      if (!isState(value)) throw new UnknownStateError(entity, value);
      return value;
    },
    canTransition: (from: S, to: S) => allowed.get(from)?.has(to) ?? false,
    assertTransition(from: S, to: S) {
      if (!isState(from)) throw new UnknownStateError(entity, from);
      if (!isState(to)) throw new UnknownStateError(entity, to);
      if (!allowed.get(from)!.has(to)) {
        throw new IllegalTransitionError<S>(entity, from, to, frozenTargets.get(from)!);
      }
    },
    nextStates: (from: S) => frozenTargets.get(from) ?? [],
    isTerminal: (state: S) => (frozenTargets.get(state)?.length ?? 0) === 0,
  });
}
