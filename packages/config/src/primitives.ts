import { z } from "zod";

/**
 * Environment variables are always strings. `z.coerce.boolean()` treats "false" as true,
 * so booleans are parsed explicitly and anything outside the accepted set is rejected.
 */
export const booleanish = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

export const port = z.coerce.number().int().min(1).max(65_535);

export const postgresUrl = z
  .string()
  .url()
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// or postgresql:// URL");

export const httpUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//.test(v), "must be an http(s) URL")
  .transform((v) => v.replace(/\/+$/, ""));

/** 32 random bytes, base64-encoded: `node -e "console.log(crypto.randomBytes(32).toString('base64'))"` */
export const aes256Key = z.string().refine((v) => {
  try {
    return Buffer.from(v, "base64").length === 32;
  } catch {
    return false;
  }
}, "must be 32 bytes encoded as base64");

export const prefixed = (prefix: string | readonly string[]) => {
  const prefixes = typeof prefix === "string" ? [prefix] : prefix;
  return z
    .string()
    .min(prefixes[0]!.length + 8)
    .refine((v) => prefixes.some((p) => v.startsWith(p)), `must start with ${prefixes.join(" or ")}`);
};

/** Treats empty strings as unset — `.env` files commonly contain `KEY=` for unused values. */
export const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
