-- Bootstrap (hand-written): extensions and the Supabase auth schema.
-- On Supabase `auth.users` already exists and these statements are no-ops; on plain Postgres
-- (local docker, CI) they create a minimal stub so foreign keys to auth.users resolve.
CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "auth";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth"."users" ("id" uuid PRIMARY KEY);--> statement-breakpoint
CREATE TYPE "public"."ai_task" AS ENUM('listing', 'pricing_hint', 'ad_copy', 'support_reply', 'review_summary');--> statement-breakpoint
CREATE TYPE "public"."cart_status" AS ENUM('active', 'checkout_started', 'abandoned', 'recovered', 'converted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'paid', 'fulfillment_queued', 'placed_with_supplier', 'awaiting_supplier_payment', 'supplier_paid', 'shipped', 'delivered', 'fulfillment_failed', 'manual_review', 'cancelled', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('imported', 'enriching', 'enrichment_failed', 'pending_review', 'published', 'paused', 'out_of_stock', 'archived');--> statement-breakpoint
CREATE TYPE "public"."supplier_order_status" AS ENUM('creating', 'created', 'paid', 'shipped', 'delivered', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'support', 'customer');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid,
	"full_name" text NOT NULL,
	"phone" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"zip" text,
	"country" char(2) DEFAULT 'IL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" "user_role" DEFAULT 'customer' NOT NULL,
	"email" "citext" NOT NULL,
	"full_name" text,
	"phone" text,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"marketing_opt_in_at" timestamp with time zone,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_email_unique" UNIQUE("email"),
	CONSTRAINT "profiles_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "pricing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"target_margin_pct" numeric(5, 2) NOT NULL,
	"min_profit_minor" integer NOT NULL,
	"positioning_mult" jsonb DEFAULT '{"budget":0.95,"mid":1,"premium":1.15}'::jsonb NOT NULL,
	"max_price_minor" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pricing_rules_scope_check" CHECK ("pricing_rules"."scope" ~ '^(global|category:.+|product:[0-9a-f-]{36})$'),
	CONSTRAINT "pricing_rules_margin_range" CHECK ("pricing_rules"."target_margin_pct" >= 0 and "pricing_rules"."target_margin_pct" < 100)
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"source_url" text NOT NULL,
	"storage_key" text,
	"alt_text" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"external_sku_id" text NOT NULL,
	"options" jsonb NOT NULL,
	"supplier_cost_minor" integer NOT NULL,
	"supplier_currency" char(3) DEFAULT 'USD' NOT NULL,
	"shipping_cost_minor" integer NOT NULL,
	"shipping_method" text,
	"shipping_days_min" integer,
	"shipping_days_max" integer,
	"price_minor" integer,
	"compare_at_minor" integer,
	"stock" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"price_calc" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_product_sku_key" UNIQUE("product_id","external_sku_id"),
	CONSTRAINT "product_variants_costs_nonnegative" CHECK ("product_variants"."supplier_cost_minor" >= 0 and "product_variants"."shipping_cost_minor" >= 0),
	CONSTRAINT "product_variants_price_positive" CHECK ("product_variants"."price_minor" is null or "product_variants"."price_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier" text DEFAULT 'aliexpress' NOT NULL,
	"external_id" text NOT NULL,
	"latest_snapshot_id" uuid,
	"status" "product_status" DEFAULT 'imported' NOT NULL,
	"slug" text,
	"title" text,
	"seo_title" text,
	"meta_description" text,
	"description_html" text,
	"bullets" text[] DEFAULT '{}'::text[] NOT NULL,
	"category" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"risk_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"positioning" text,
	"active_ai_generation_id" uuid,
	"published_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_supplier_external_id_key" UNIQUE("supplier","external_id"),
	CONSTRAINT "products_positioning_check" CHECK ("products"."positioning" in ('budget', 'mid', 'premium'))
);
--> statement-breakpoint
CREATE TABLE "supplier_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier" text DEFAULT 'aliexpress' NOT NULL,
	"external_id" text NOT NULL,
	"source_url" text,
	"raw" jsonb NOT NULL,
	"raw_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_products_supplier_external_hash_key" UNIQUE("supplier","external_id","raw_hash")
);
--> statement-breakpoint
CREATE TABLE "ai_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" "ai_task" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"output" jsonb,
	"status" text NOT NULL,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cost_usd_micros" bigint,
	"latency_ms" integer,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_generations_status_check" CHECK ("ai_generations"."status" in ('ok', 'refusal', 'parse_error', 'api_error', 'rejected_by_validator'))
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"cart_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	CONSTRAINT "cart_items_cart_id_variant_id_pk" PRIMARY KEY("cart_id","variant_id"),
	CONSTRAINT "cart_items_qty_positive" CHECK ("cart_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid,
	"email" "citext",
	"status" "cart_status" DEFAULT 'active' NOT NULL,
	"recovery_token" text,
	"recovery_step" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_recovery_token_unique" UNIQUE("recovery_token")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"external_sku_id" text NOT NULL,
	"title_snapshot" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"unit_cost_minor_usd" integer NOT NULL,
	CONSTRAINT "order_items_qty_positive" CHECK ("order_items"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigserial NOT NULL,
	"profile_id" uuid,
	"email" "citext" NOT NULL,
	"cart_id" uuid,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"currency" char(3) DEFAULT 'ILS' NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"shipping_minor" integer DEFAULT 0 NOT NULL,
	"vat_minor" integer NOT NULL,
	"total_minor" integer NOT NULL,
	"shipping_address" jsonb NOT NULL,
	"stripe_checkout_id" text,
	"stripe_payment_intent" text,
	"status_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "orders_number_unique" UNIQUE("number"),
	CONSTRAINT "orders_stripe_checkout_id_unique" UNIQUE("stripe_checkout_id"),
	CONSTRAINT "orders_stripe_payment_intent_unique" UNIQUE("stripe_payment_intent"),
	CONSTRAINT "orders_amounts_nonnegative" CHECK ("orders"."subtotal_minor" >= 0 and "orders"."shipping_minor" >= 0 and "orders"."vat_minor" >= 0 and "orders"."total_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_order_id" uuid NOT NULL,
	"carrier" text,
	"tracking_number" text,
	"status" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supplier_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"supplier" text DEFAULT 'aliexpress' NOT NULL,
	"external_order_id" text,
	"status" "supplier_order_status" DEFAULT 'creating' NOT NULL,
	"idempotency_key" text NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"cost_minor_usd" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_orders_external_order_id_unique" UNIQUE("external_order_id"),
	CONSTRAINT "supplier_orders_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"tool_calls" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_messages_role_check" CHECK ("support_messages"."role" in ('customer', 'ai', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"order_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_status_check" CHECK ("support_tickets"."status" in ('open', 'ai_answered', 'escalated', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("audit_log"."actor_type" in ('user', 'system', 'ai', 'webhook'))
);
--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"provider" text PRIMARY KEY NOT NULL,
	"secret_cipher" "bytea" NOT NULL,
	"expires_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_provider_event_id_key" UNIQUE("provider","event_id")
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"product_id" uuid,
	"external_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"daily_budget_minor" integer NOT NULL,
	"creative" jsonb NOT NULL,
	"approved_by" uuid,
	"metrics" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_campaigns_platform_check" CHECK ("ad_campaigns"."platform" in ('meta', 'tiktok')),
	CONSTRAINT "ad_campaigns_status_check" CHECK ("ad_campaigns"."status" in ('draft', 'pending_approval', 'active', 'paused')),
	CONSTRAINT "ad_campaigns_budget_positive" CHECK ("ad_campaigns"."daily_budget_minor" > 0),
	CONSTRAINT "ad_campaigns_active_requires_approval" CHECK ("ad_campaigns"."status" <> 'active' or "ad_campaigns"."approved_by" is not null)
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_latest_snapshot_id_supplier_products_id_fk" FOREIGN KEY ("latest_snapshot_id") REFERENCES "public"."supplier_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_active_ai_generation_id_ai_generations_id_fk" FOREIGN KEY ("active_ai_generation_id") REFERENCES "public"."ai_generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_supplier_order_id_supplier_orders_id_fk" FOREIGN KEY ("supplier_order_id") REFERENCES "public"."supplier_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_approved_by_profiles_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addresses_profile_id_idx" ON "addresses" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "product_images_product_id_idx" ON "product_images" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "products_fts" ON "products" USING gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("category", '')));--> statement-breakpoint
CREATE INDEX "ai_generations_subject_idx" ON "ai_generations" USING btree ("subject_type","subject_id","task");--> statement-breakpoint
CREATE INDEX "ai_generations_input_hash_idx" ON "ai_generations" USING btree ("input_hash");--> statement-breakpoint
CREATE INDEX "ai_generations_created_at_idx" ON "ai_generations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "carts_recovery_scan_idx" ON "carts" USING btree ("status","last_activity_at");--> statement-breakpoint
CREATE INDEX "carts_profile_id_idx" ON "carts" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_profile_id_idx" ON "orders" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "orders_email_idx" ON "orders" USING btree ("email");--> statement-breakpoint
CREATE INDEX "shipments_supplier_order_id_idx" ON "shipments" USING btree ("supplier_order_id");--> statement-breakpoint
CREATE INDEX "shipments_tracking_number_idx" ON "shipments" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "supplier_orders_order_id_idx" ON "supplier_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "supplier_orders_status_idx" ON "supplier_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "support_messages_ticket_id_idx" ON "support_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_email_idx" ON "support_tickets" USING btree ("email");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "ad_campaigns_status_idx" ON "ad_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ad_campaigns_product_id_idx" ON "ad_campaigns" USING btree ("product_id");--> statement-breakpoint
-- Row level security (hand-written): deny-by-default for the anon/authenticated roles.
-- The server and worker connect as the table owner and are unaffected; customer-facing
-- policies are added alongside the features that need them.
ALTER TABLE "addresses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pricing_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "product_images" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "supplier_products" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ai_generations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cart_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "carts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "supplier_orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "support_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration_credentials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ad_campaigns" ENABLE ROW LEVEL SECURITY;
