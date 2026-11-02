// The Anthropic SDK's structured-output helpers are built on Zod 4 (`zod/v4`).
import { z } from "zod/v4";

export const RISK_FLAGS = [
  "trademark_or_brand",
  "medical_or_health_claim",
  "battery_or_hazmat",
  "electrical_plug_type",
  "children_safety",
  "cosmetics_regulated",
  "size_chart_unclear",
  "low_quality_source_data",
  "suspicious_instructions_in_source",
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

/**
 * What Claude must return for a product listing. Length limits are described to the model and
 * enforced afterwards by `checkListingRules` (JSON-schema string limits are not supported by
 * structured outputs).
 */
export const ListingOutput = z.object({
  title: z
    .string()
    .describe("Hebrew product name. Natural, specific, max 70 characters. No third-party brand names."),
  seo_title: z.string().describe("Hebrew, max 60 characters, primary keyword first."),
  meta_description: z.string().describe("Hebrew, 120-155 characters, ends with a call to action."),
  slug: z
    .string()
    .describe("Latin lowercase kebab-case, max 60 characters, describes the product (not a brand)."),
  bullets: z.array(z.string()).describe("3-6 concrete benefits in Hebrew, one short sentence each."),
  description_html: z
    .string()
    .describe(
      "Hebrew HTML using only h2, h3, p, ul, ol, li, strong, em, table, thead, tbody, tr, th, td, br.",
    ),
  category: z.string().describe("Hebrew store category, 1-3 words, e.g. 'אביזרי רכב'."),
  tags: z.array(z.string()).describe("3-10 Hebrew search tags."),
  target_audience: z.string().describe("Who buys this, in one Hebrew sentence."),
  positioning: z.enum(["budget", "standard", "premium"]),
  ad_angles: z
    .array(z.object({ hook: z.string(), angle: z.string() }))
    .describe("2-4 advertising angles in Hebrew; the hook is the first line of an ad."),
  risk_flags: z.array(z.enum(RISK_FLAGS)),
  confidence: z.enum(["low", "medium", "high"]),
});
export type ListingOutput = z.infer<typeof ListingOutput>;

export type RuleViolation = { field: keyof ListingOutput; message: string };

const HEBREW = /[֐-׿]/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Business rules a JSON schema cannot express. An empty list means the listing is acceptable. */
export function checkListingRules(listing: ListingOutput): RuleViolation[] {
  const v: RuleViolation[] = [];
  const len = (field: keyof ListingOutput, value: string, min: number, max: number) => {
    const n = [...value.trim()].length;
    if (n < min || n > max) v.push({ field, message: `length ${n}, expected ${min}-${max}` });
  };

  len("title", listing.title, 5, 70);
  len("seo_title", listing.seo_title, 5, 60);
  len("meta_description", listing.meta_description, 50, 160);
  len("slug", listing.slug, 3, 60);
  len("category", listing.category, 2, 40);
  if (!SLUG.test(listing.slug)) v.push({ field: "slug", message: "must be lowercase kebab-case latin" });
  for (const field of ["title", "seo_title", "meta_description", "category"] as const) {
    if (!HEBREW.test(listing[field])) v.push({ field, message: "must be written in Hebrew" });
  }
  if (listing.bullets.length < 3 || listing.bullets.length > 6) {
    v.push({ field: "bullets", message: `${listing.bullets.length} bullets, expected 3-6` });
  }
  if (listing.bullets.some((b) => [...b].length > 160))
    v.push({ field: "bullets", message: "a bullet exceeds 160 characters" });
  if (listing.tags.length < 3 || listing.tags.length > 10)
    v.push({ field: "tags", message: `${listing.tags.length} tags, expected 3-10` });
  if (listing.description_html.trim().length < 80)
    v.push({ field: "description_html", message: "description too short" });
  if (listing.description_html.length > 12_000)
    v.push({ field: "description_html", message: "description too long" });
  return v;
}
