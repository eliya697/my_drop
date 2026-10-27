ALTER TABLE "products" DROP CONSTRAINT "products_positioning_check";--> statement-breakpoint
-- Data (hand-written): rename the 'mid' positioning tier to 'standard' before re-adding the check.
UPDATE "products" SET "positioning" = 'standard' WHERE "positioning" = 'mid';--> statement-breakpoint
UPDATE "pricing_rules" SET "positioning_mult" = ("positioning_mult" - 'mid') || jsonb_build_object('standard', "positioning_mult"->'mid') WHERE "positioning_mult" ? 'mid';--> statement-breakpoint
ALTER TABLE "pricing_rules" ALTER COLUMN "positioning_mult" SET DEFAULT '{"budget":0.95,"standard":1,"premium":1.15}'::jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_positioning_check" CHECK ("products"."positioning" in ('budget', 'standard', 'premium'));