CREATE TABLE "ai_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_batch_id" text NOT NULL,
	"task" "ai_task" NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"item_count" integer NOT NULL,
	"subject_ids" uuid[] NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "ai_batches_provider_batch_id_unique" UNIQUE("provider_batch_id"),
	CONSTRAINT "ai_batches_status_check" CHECK ("ai_batches"."status" in ('submitted', 'ended', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD COLUMN "markup_pct" numeric(6, 2) DEFAULT '60.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD COLUMN "normalized" jsonb;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD COLUMN "fallback_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD COLUMN "batch" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_batches_status_idx" ON "ai_batches" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_rules_active_scope_key" ON "pricing_rules" USING btree ("scope") WHERE "pricing_rules"."is_active";--> statement-breakpoint
-- Hand-written: deny-by-default RLS on the new table (see 0000_init).
ALTER TABLE "ai_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Hand-written: a default global pricing rule so pricing works out of the box. Tune it in the
-- admin later: 60% markup on landed cost, at least 20% margin and ₪15 profit per unit.
INSERT INTO "pricing_rules" ("scope", "target_margin_pct", "markup_pct", "min_profit_minor", "positioning_mult")
SELECT 'global', 20.00, 60.00, 1500, '{"budget":0.95,"standard":1,"premium":1.15}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM "pricing_rules" WHERE "scope" = 'global' AND "is_active");
