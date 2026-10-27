import { ORDER_STATUSES, PRODUCT_STATUSES } from "@dropship/core";
import { pgEnum } from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["owner", "admin", "support", "customer"]);

// Lifecycle states are owned by the state machines in @dropship/core.
export const productStatus = pgEnum("product_status", PRODUCT_STATUSES);

export const orderStatus = pgEnum("order_status", ORDER_STATUSES);

export const supplierOrderStatus = pgEnum("supplier_order_status", [
  "creating",
  "created",
  "paid",
  "shipped",
  "delivered",
  "failed",
  "cancelled",
]);

export const aiTask = pgEnum("ai_task", [
  "listing",
  "pricing_hint",
  "ad_copy",
  "support_reply",
  "review_summary",
]);

export const cartStatus = pgEnum("cart_status", [
  "active",
  "checkout_started",
  "abandoned",
  "recovered",
  "converted",
  "expired",
]);

export type UserRole = (typeof userRole.enumValues)[number];
export type ProductStatus = (typeof productStatus.enumValues)[number];
export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type SupplierOrderStatus = (typeof supplierOrderStatus.enumValues)[number];
export type AiTask = (typeof aiTask.enumValues)[number];
export type CartStatus = (typeof cartStatus.enumValues)[number];
