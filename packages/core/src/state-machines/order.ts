import { defineStateMachine } from "./machine";

/**
 * Order lifecycle. These values are the source of truth for the `order_status` Postgres enum
 * (packages/db imports them), so append new states at the end — Postgres cannot reorder enums.
 *
 * Happy path:
 *   pending_payment → paid → fulfillment_queued → placed_with_supplier
 *     → [awaiting_supplier_payment →] supplier_paid → shipped → delivered
 *
 * Failure path:
 *   fulfillment_queued | placed_with_supplier | awaiting_supplier_payment | supplier_paid
 *     → fulfillment_failed → manual_review → (fulfillment_queued | refunded | partially_refunded)
 *
 * Money rules encoded here:
 *   - `cancelled` is only reachable before payment. Once money is captured, the only exits are
 *     fulfilment or a refund — an order can never be "cancelled" while holding the customer's money.
 *   - Refunds are possible from every post-payment state; the refund amount is decided elsewhere.
 */
export const ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "fulfillment_queued",
  "placed_with_supplier",
  "awaiting_supplier_payment",
  "supplier_paid",
  "shipped",
  "delivered",
  "fulfillment_failed",
  "manual_review",
  "cancelled",
  "refunded",
  "partially_refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const orderMachine = defineStateMachine<OrderStatus>({
  entity: "order",
  states: ORDER_STATUSES,
  initial: "pending_payment",
  transitions: {
    pending_payment: ["paid", "cancelled"],
    paid: ["fulfillment_queued", "refunded", "partially_refunded"],
    fulfillment_queued: ["placed_with_supplier", "fulfillment_failed", "refunded", "partially_refunded"],
    // The supplier either charges automatically (→ supplier_paid) or waits for us to pay.
    placed_with_supplier: ["awaiting_supplier_payment", "supplier_paid", "fulfillment_failed"],
    awaiting_supplier_payment: ["supplier_paid", "fulfillment_failed"],
    // A supplier can still cancel after payment (seller out of stock).
    supplier_paid: ["shipped", "fulfillment_failed"],
    // Lost in transit is refunded without passing through `delivered`.
    shipped: ["delivered", "refunded", "partially_refunded"],
    delivered: ["refunded", "partially_refunded"],
    fulfillment_failed: ["manual_review"],
    manual_review: ["fulfillment_queued", "refunded", "partially_refunded"],
    partially_refunded: ["refunded"],
    cancelled: [],
    refunded: [],
  },
});

/** States in which the customer has paid and nothing has been refunded yet. */
export const PAID_ORDER_STATUSES: readonly OrderStatus[] = [
  "paid",
  "fulfillment_queued",
  "placed_with_supplier",
  "awaiting_supplier_payment",
  "supplier_paid",
  "shipped",
  "delivered",
  "fulfillment_failed",
  "manual_review",
];

/** States that need a human and must page someone. */
export const ATTENTION_ORDER_STATUSES: readonly OrderStatus[] = ["fulfillment_failed", "manual_review"];

export const canRefund = (status: OrderStatus): boolean =>
  orderMachine.canTransition(status, "refunded") || orderMachine.canTransition(status, "partially_refunded");
