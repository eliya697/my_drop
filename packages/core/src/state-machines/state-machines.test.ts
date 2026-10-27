import { describe, expect, it } from "vitest";
import { DomainError, IllegalTransitionError, UnknownStateError } from "../errors";
import { defineStateMachine, type StateMachine } from "./machine";
import { canRefund, ORDER_STATUSES, orderMachine, PAID_ORDER_STATUSES, type OrderStatus } from "./order";
import { PRODUCT_STATUSES, productMachine, type ProductStatus } from "./product";

/** Every (from, to) pair, split into the ones the table allows and the ones it forbids. */
function allPairs<S extends string>(machine: StateMachine<S>) {
  const legal: [S, S][] = [];
  const illegal: [S, S][] = [];
  for (const from of machine.states) {
    for (const to of machine.states) {
      (machine.nextStates(from).includes(to) ? legal : illegal).push([from, to]);
    }
  }
  return { legal, illegal };
}

function reachableFrom<S extends string>(machine: StateMachine<S>, start: S): Set<S> {
  const seen = new Set<S>([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of machine.nextStates(queue.shift()!)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function expectIllegal<S extends string>(machine: StateMachine<S>, from: S, to: S) {
  try {
    machine.assertTransition(from, to);
  } catch (err) {
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect(err).toBeInstanceOf(DomainError);
    const e = err as IllegalTransitionError<S>;
    expect(e.code).toBe("ILLEGAL_TRANSITION");
    expect(e.entity).toBe(machine.entity);
    expect(e.from).toBe(from);
    expect(e.to).toBe(to);
    expect(e.allowed).toEqual(machine.nextStates(from));
    return;
  }
  throw new Error(`expected ${from} -> ${to} to be illegal`);
}

describe.each([
  // [name, machine, states every record must always be able to reach eventually]
  ["product", productMachine as StateMachine<string>, ["archived"]],
  ["order", orderMachine as StateMachine<string>, ["cancelled", "refunded"]],
])("%s state machine — structural invariants", (_name, machine, exits) => {
  const { legal, illegal } = allPairs(machine);

  it("accepts every transition in the table", () => {
    for (const [from, to] of legal) {
      expect(machine.canTransition(from, to)).toBe(true);
      expect(() => machine.assertTransition(from, to)).not.toThrow();
    }
  });

  it("rejects every transition not in the table with a typed error", () => {
    expect(illegal.length).toBeGreaterThan(0);
    for (const [from, to] of illegal) {
      expect(machine.canTransition(from, to)).toBe(false);
      expectIllegal(machine, from, to);
    }
  });

  it("never allows a self-transition", () => {
    for (const s of machine.states) expect(machine.canTransition(s, s)).toBe(false);
  });

  it("can reach every state from the initial state", () => {
    expect([...reachableFrom(machine, machine.initial)].sort()).toEqual([...machine.states].sort());
  });

  it("can always reach an exit state (no record gets trapped in a loop)", () => {
    for (const s of machine.states) {
      const reach = reachableFrom(machine, s);
      expect(
        exits.some((exit) => reach.has(exit)),
        `${s} cannot reach ${exits.join(" or ")}`,
      ).toBe(true);
    }
  });

  it("rejects unknown states", () => {
    expect(() => machine.parseState("nonsense")).toThrow(UnknownStateError);
    expect(() => machine.parseState(42)).toThrow(UnknownStateError);
    expect(() => machine.assertTransition("nonsense", machine.initial)).toThrow(UnknownStateError);
    expect(machine.isState(machine.initial)).toBe(true);
    expect(machine.isState(undefined)).toBe(false);
  });

  it("is immutable", () => {
    expect(Object.isFrozen(machine)).toBe(true);
    expect(Object.isFrozen(machine.states)).toBe(true);
    expect(Object.isFrozen(machine.nextStates(machine.initial))).toBe(true);
  });
});

describe("product lifecycle", () => {
  const happyPath: ProductStatus[] = ["imported", "enriching", "pending_review", "published", "archived"];

  it("walks the happy path", () => {
    for (let i = 1; i < happyPath.length; i++) {
      expect(() => productMachine.assertTransition(happyPath[i - 1]!, happyPath[i]!)).not.toThrow();
    }
  });

  it("covers every product status", () => {
    expect(productMachine.states).toEqual(PRODUCT_STATUSES);
  });

  it.each<[ProductStatus, ProductStatus]>([
    ["imported", "published"],
    ["enriching", "published"],
    ["enrichment_failed", "published"],
    ["archived", "published"],
  ])("cannot publish without review: %s -> %s", (from, to) => {
    expectIllegal(productMachine, from, to);
  });

  it("routes a restored product back through review", () => {
    expect(productMachine.nextStates("archived")).toEqual(["pending_review"]);
  });

  it("lets a failed enrichment be retried or hand-written", () => {
    expect(productMachine.canTransition("enrichment_failed", "enriching")).toBe(true);
    expect(productMachine.canTransition("enrichment_failed", "pending_review")).toBe(true);
  });

  it("toggles between published, paused and out_of_stock", () => {
    expect(productMachine.canTransition("published", "paused")).toBe(true);
    expect(productMachine.canTransition("paused", "published")).toBe(true);
    expect(productMachine.canTransition("published", "out_of_stock")).toBe(true);
    expect(productMachine.canTransition("out_of_stock", "published")).toBe(true);
  });
});

describe("order lifecycle", () => {
  it("walks the auto-pay happy path", () => {
    const path: OrderStatus[] = [
      "pending_payment",
      "paid",
      "fulfillment_queued",
      "placed_with_supplier",
      "supplier_paid",
      "shipped",
      "delivered",
    ];
    for (let i = 1; i < path.length; i++) orderMachine.assertTransition(path[i - 1]!, path[i]!);
  });

  it("walks the manual supplier-payment path", () => {
    orderMachine.assertTransition("placed_with_supplier", "awaiting_supplier_payment");
    orderMachine.assertTransition("awaiting_supplier_payment", "supplier_paid");
  });

  it("covers every order status", () => {
    expect(orderMachine.states).toEqual(ORDER_STATUSES);
  });

  it("has exactly two terminal states", () => {
    expect([...orderMachine.terminal].sort()).toEqual(["cancelled", "refunded"]);
  });

  it("only cancels before payment — a paid order must be refunded instead", () => {
    const cancellableFrom = orderMachine.states.filter((s) => orderMachine.canTransition(s, "cancelled"));
    expect(cancellableFrom).toEqual(["pending_payment"]);
    for (const s of PAID_ORDER_STATUSES) expectIllegal(orderMachine, s, "cancelled");
  });

  it("can eventually refund every paid order", () => {
    for (const s of PAID_ORDER_STATUSES) {
      expect(reachableFrom(orderMachine, s).has("refunded"), `${s} cannot reach refunded`).toBe(true);
    }
  });

  it("refunds directly only where no supplier money is committed", () => {
    // Once the supplier order exists, a human must cancel it with the supplier first, so the
    // refund goes through fulfillment_failed -> manual_review.
    const direct = orderMachine.states.filter(canRefund);
    expect(direct.sort()).toEqual(
      ["delivered", "fulfillment_queued", "manual_review", "paid", "partially_refunded", "shipped"].sort(),
    );
    for (const s of ["placed_with_supplier", "awaiting_supplier_payment", "supplier_paid"] as const) {
      expect(canRefund(s)).toBe(false);
    }
  });

  it.each<[OrderStatus, OrderStatus]>([
    ["pending_payment", "fulfillment_queued"],
    ["pending_payment", "shipped"],
    ["paid", "shipped"],
    ["fulfillment_queued", "shipped"],
    ["placed_with_supplier", "shipped"],
    ["delivered", "shipped"],
    ["refunded", "paid"],
    ["cancelled", "paid"],
    ["fulfillment_failed", "fulfillment_queued"],
  ])("rejects %s -> %s", (from, to) => {
    expectIllegal(orderMachine, from, to);
  });

  it("forces failed fulfilment through manual review before a retry", () => {
    expect(orderMachine.nextStates("fulfillment_failed")).toEqual(["manual_review"]);
    expect(orderMachine.canTransition("manual_review", "fulfillment_queued")).toBe(true);
  });

  it("explains terminal states in the error message", () => {
    expect(() => orderMachine.assertTransition("refunded", "paid")).toThrow(/refunded is terminal/);
  });
});

describe("defineStateMachine — table validation", () => {
  it("rejects a table that references an unknown state", () => {
    expect(() =>
      defineStateMachine<"a" | "b">({
        entity: "t",
        states: ["a", "b"],
        initial: "a",
        transitions: { a: ["c" as "b"], b: [] },
      }),
    ).toThrow(/unknown state c/);
  });

  it("rejects a self-transition", () => {
    expect(() =>
      defineStateMachine<"a">({ entity: "t", states: ["a"], initial: "a", transitions: { a: ["a"] } }),
    ).toThrow(/self-transition/);
  });

  it("rejects a state with no row in the table", () => {
    expect(() =>
      defineStateMachine<"a" | "b">({
        entity: "t",
        states: ["a", "b"],
        initial: "a",
        transitions: { a: ["b"] } as never,
      }),
    ).toThrow(/missing from transition table/);
  });
});
