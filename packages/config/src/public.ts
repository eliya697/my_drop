import { z } from "zod";
import { httpUrl, optional, prefixed } from "./primitives";
import { parseEnv } from "./parse";

/**
 * Variables exposed to the browser. Next.js only inlines `process.env.NEXT_PUBLIC_*` when the
 * property is accessed literally, so the source object below must spell out every key.
 */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SITE_URL: httpUrl,
  NEXT_PUBLIC_SUPABASE_URL: optional(httpUrl),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optional(z.string().min(20)),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: optional(prefixed(["pk_live_", "pk_test_"])),
});
export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function loadPublicEnv(): PublicEnv {
  return parseEnv(
    publicEnvSchema,
    {
      NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    },
    "public (browser)",
  );
}
