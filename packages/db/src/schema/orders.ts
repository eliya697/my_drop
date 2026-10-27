import { sql } from "drizzle-orm";
import {
  bigserial,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { carts } from "./carts";
import { productVariants } from "./catalog";
import { orderStatus, supplierOrderStatus } from "./enums";
import { citext } from "./types";
import { profiles } from "./users";

export type ShippingAddressSnapshot = {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  zip?: string | null;
  country: string;
};

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Customer-facing order number. */
    number: bigserial("number", { mode: "number" }).notNull().unique(),
    profileId: uuid("profile_id").references(() => profiles.id),
    email: citext("email").notNull(),
    cartId: uuid("cart_id").references(() => carts.id),
    status: orderStatus("status").notNull().default("pending_payment"),
    currency: char("currency", { length: 3 })
      .notNull()
      .default(sql`'ILS'`),
    subtotalMinor: integer("subtotal_minor").notNull(),
    shippingMinor: integer("shipping_minor").notNull().default(0),
    vatMinor: integer("vat_minor").notNull(),
    totalMinor: integer("total_minor").notNull(),
    /** Snapshot at purchase time — intentionally not a foreign key to `addresses`. */
    shippingAddress: jsonb("shipping_address").$type<ShippingAddressSnapshot>().notNull(),
    stripeCheckoutId: text("stripe_checkout_id").unique(),
    stripePaymentIntent: text("stripe_payment_intent").unique(),
    statusReason: text("status_reason"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => [
    index("orders_status_idx").on(t.status),
    index("orders_profile_id_idx").on(t.profileId),
    index("orders_email_idx").on(t.email),
    check(
      "orders_amounts_nonnegative",
      sql`${t.subtotalMinor} >= 0 and ${t.shippingMinor} >= 0 and ${t.vatMinor} >= 0 and ${t.totalMinor} >= 0`,
    ),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    externalSkuId: text("external_sku_id").notNull(),
    titleSnapshot: text("title_snapshot").notNull(),
    qty: integer("qty").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    /** Supplier cost at purchase time (USD cents), for actual-profit reporting. */
    unitCostMinorUsd: integer("unit_cost_minor_usd").notNull(),
  },
  (t) => [
    index("order_items_order_id_idx").on(t.orderId),
    check("order_items_qty_positive", sql`${t.qty} > 0`),
  ],
);

/** One customer order can split into several supplier orders (one per AliExpress seller). */
export const supplierOrders = pgTable(
  "supplier_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    supplier: text("supplier").notNull().default("aliexpress"),
    externalOrderId: text("external_order_id").unique(),
    status: supplierOrderStatus("status").notNull().default("creating"),
    /** `${order_id}:${seller_id}` — guarantees a retry never places a duplicate supplier order. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    request: jsonb("request"),
    response: jsonb("response"),
    costMinorUsd: integer("cost_minor_usd"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("supplier_orders_order_id_idx").on(t.orderId),
    index("supplier_orders_status_idx").on(t.status),
  ],
);

export type ShipmentStatus = "in_transit" | "out_for_delivery" | "delivered" | "exception";

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierOrderId: uuid("supplier_order_id")
      .notNull()
      .references(() => supplierOrders.id),
    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),
    status: text("status").$type<ShipmentStatus>(),
    events: jsonb("events")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [
    index("shipments_supplier_order_id_idx").on(t.supplierOrderId),
    index("shipments_tracking_number_idx").on(t.trackingNumber),
  ],
);
