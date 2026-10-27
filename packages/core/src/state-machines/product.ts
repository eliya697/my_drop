import { defineStateMachine } from "./machine";

/**
 * Product lifecycle. These values are the source of truth for the `product_status` Postgres enum
 * (packages/db imports them), so append new states at the end — Postgres cannot reorder enums.
 *
 * Happy path:  imported → enriching → pending_review → published
 * After that:  published ⇄ paused, published ⇄ out_of_stock
 * Failures:    enriching → enrichment_failed → (enriching | pending_review)
 * Every product reaches `published` only through `pending_review`, including restores from `archived`.
 */
export const PRODUCT_STATUSES = [
  "imported",
  "enriching",
  "enrichment_failed",
  "pending_review",
  "published",
  "paused",
  "out_of_stock",
  "archived",
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const productMachine = defineStateMachine<ProductStatus>({
  entity: "product",
  states: PRODUCT_STATUSES,
  initial: "imported",
  transitions: {
    imported: ["enriching", "archived"],
    enriching: ["pending_review", "enrichment_failed"],
    // Retry the AI pass, or an admin writes the copy by hand and sends it to review.
    enrichment_failed: ["enriching", "pending_review", "archived"],
    // Approve, regenerate, or reject.
    pending_review: ["published", "enriching", "archived"],
    published: ["paused", "out_of_stock", "archived"],
    paused: ["published", "archived"],
    out_of_stock: ["published", "paused", "archived"],
    // Restoring an archived product always requires a fresh human review.
    archived: ["pending_review"],
  },
});

/** States in which the product is visible and purchasable in the storefront. */
export const SELLABLE_PRODUCT_STATUSES: readonly ProductStatus[] = ["published"];
