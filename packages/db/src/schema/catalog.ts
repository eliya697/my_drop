import type { PricingTier } from "@dropship/core";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { aiGenerations } from "./ai";
import { productStatus } from "./enums";

/** Positioning tiers are owned by the pricing engine in @dropship/core. */
export type Positioning = PricingTier;
export type PositioningMultipliers = Record<Positioning, number>;

/** Immutable raw snapshots from the supplier API; a new row is written only when `raw_hash` changes. */
export const supplierProducts = pgTable(
  "supplier_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplier: text("supplier").notNull().default("aliexpress"),
    externalId: text("external_id").notNull(),
    sourceUrl: text("source_url"),
    raw: jsonb("raw").notNull(),
    /** The supplier-neutral product (SupplierProduct without `raw`) derived from `raw`. */
    normalized: jsonb("normalized"),
    rawHash: text("raw_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("supplier_products_supplier_external_hash_key").on(t.supplier, t.externalId, t.rawHash)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplier: text("supplier").notNull().default("aliexpress"),
    externalId: text("external_id").notNull(),
    latestSnapshotId: uuid("latest_snapshot_id").references(() => supplierProducts.id),
    status: productStatus("status").notNull().default("imported"),
    slug: text("slug").unique(),
    title: text("title"),
    seoTitle: text("seo_title"),
    metaDescription: text("meta_description"),
    /** Always sanitized before insert — never store model or supplier HTML as-is. */
    descriptionHtml: text("description_html"),
    bullets: text("bullets")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    category: text("category"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    riskFlags: text("risk_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    positioning: text("positioning").$type<Positioning>(),
    activeAiGenerationId: uuid("active_ai_generation_id").references((): AnyPgColumn => aiGenerations.id),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("products_supplier_external_id_key").on(t.supplier, t.externalId),
    index("products_status_idx").on(t.status),
    index("products_fts").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${t.title}, '') || ' ' || coalesce(${t.category}, ''))`,
    ),
    check("products_positioning_check", sql`${t.positioning} in ('budget', 'standard', 'premium')`),
  ],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** AliExpress sku_id — required to place the supplier order. */
    externalSkuId: text("external_sku_id").notNull(),
    options: jsonb("options").$type<Record<string, string>>().notNull(),
    /** Supplier cost in minor units of `supplier_currency` (USD cents). */
    supplierCostMinor: integer("supplier_cost_minor").notNull(),
    supplierCurrency: char("supplier_currency", { length: 3 })
      .notNull()
      .default(sql`'USD'`),
    shippingCostMinor: integer("shipping_cost_minor").notNull(),
    shippingMethod: text("shipping_method"),
    shippingDaysMin: integer("shipping_days_min"),
    shippingDaysMax: integer("shipping_days_max"),
    /** Retail price in ILS agorot, VAT included. */
    priceMinor: integer("price_minor"),
    compareAtMinor: integer("compare_at_minor"),
    stock: integer("stock").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    /** Full pricing breakdown that produced `price_minor`, kept for audit. */
    priceCalc: jsonb("price_calc"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("product_variants_product_sku_key").on(t.productId, t.externalSkuId),
    check(
      "product_variants_costs_nonnegative",
      sql`${t.supplierCostMinor} >= 0 and ${t.shippingCostMinor} >= 0`,
    ),
    check("product_variants_price_positive", sql`${t.priceMinor} is null or ${t.priceMinor} > 0`),
  ],
);

export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "set null" }),
    sourceUrl: text("source_url").notNull(),
    /** R2 object key after download and optimization. */
    storageKey: text("storage_key"),
    width: integer("width"),
    height: integer("height"),
    altText: text("alt_text"),
    position: integer("position").notNull().default(0),
    /** Set when the image was permanently rejected (bad host, not an image, too small). */
    failedReason: text("failed_reason"),
  },
  (t) => [
    index("product_images_product_id_idx").on(t.productId, t.position),
    unique("product_images_product_source_key").on(t.productId, t.sourceUrl),
  ],
);

export const pricingRules = pgTable(
  "pricing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'global' | 'category:<name>' | 'product:<uuid>' */
    scope: text("scope").notNull().default("global"),
    /** Hard floor: minimum profit as % of revenue after VAT (the pricing engine's minMarginRate). */
    targetMarginPct: numeric("target_margin_pct", { precision: 5, scale: 2 }).notNull(),
    /** Desired profit as % of landed cost (the pricing engine's markupRate). */
    markupPct: numeric("markup_pct", { precision: 6, scale: 2 }).notNull().default("60.00"),
    minProfitMinor: integer("min_profit_minor").notNull(),
    positioningMult: jsonb("positioning_mult")
      .$type<PositioningMultipliers>()
      .notNull()
      .default({ budget: 0.95, standard: 1.0, premium: 1.15 }),
    maxPriceMinor: integer("max_price_minor"),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    // Exactly one active rule per scope, so pricing never depends on row order.
    uniqueIndex("pricing_rules_active_scope_key")
      .on(t.scope)
      .where(sql`${t.isActive}`),
    check("pricing_rules_scope_check", sql`${t.scope} ~ '^(global|category:.+|product:[0-9a-f-]{36})$'`),
    check("pricing_rules_margin_range", sql`${t.targetMarginPct} >= 0 and ${t.targetMarginPct} < 100`),
  ],
);
