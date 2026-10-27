import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { productVariants } from "./catalog";
import { cartStatus } from "./enums";
import { citext } from "./types";
import { profiles } from "./users";

export const carts = pgTable(
  "carts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id").references(() => profiles.id),
    email: citext("email"),
    status: cartStatus("status").notNull().default("active"),
    /** Signed token embedded in recovery links. */
    recoveryToken: text("recovery_token").unique(),
    /** Number of recovery emails already sent. */
    recoveryStep: integer("recovery_step").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Serves the abandoned-cart scanner, which filters on status and inactivity.
    index("carts_recovery_scan_idx").on(t.status, t.lastActivityAt),
    index("carts_profile_id_idx").on(t.profileId),
  ],
);

export const cartItems = pgTable(
  "cart_items",
  {
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    qty: integer("qty").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.cartId, t.variantId] }),
    check("cart_items_qty_positive", sql`${t.qty} > 0`),
  ],
);
