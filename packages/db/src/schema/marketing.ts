import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { products } from "./catalog";
import { profiles } from "./users";

export type AdPlatform = "meta" | "tiktok";
export type AdCampaignStatus = "draft" | "pending_approval" | "active" | "paused";

export const adCampaigns = pgTable(
  "ad_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    platform: text("platform").$type<AdPlatform>().notNull(),
    productId: uuid("product_id").references(() => products.id),
    externalId: text("external_id"),
    status: text("status").$type<AdCampaignStatus>().notNull().default("draft"),
    dailyBudgetMinor: integer("daily_budget_minor").notNull(),
    creative: jsonb("creative").notNull(),
    approvedBy: uuid("approved_by").references(() => profiles.id),
    metrics: jsonb("metrics"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ad_campaigns_status_idx").on(t.status),
    index("ad_campaigns_product_id_idx").on(t.productId),
    check("ad_campaigns_platform_check", sql`${t.platform} in ('meta', 'tiktok')`),
    check("ad_campaigns_status_check", sql`${t.status} in ('draft', 'pending_approval', 'active', 'paused')`),
    check("ad_campaigns_budget_positive", sql`${t.dailyBudgetMinor} > 0`),
    // A campaign can only be live after a human approved it.
    check(
      "ad_campaigns_active_requires_approval",
      sql`${t.status} <> 'active' or ${t.approvedBy} is not null`,
    ),
  ],
);
