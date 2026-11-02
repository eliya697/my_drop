ALTER TABLE "product_images" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "product_images" ADD COLUMN "failed_reason" text;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_source_key" UNIQUE("product_id","source_url");