import { pgSchema, uuid } from "drizzle-orm/pg-core";

/**
 * Supabase-managed `auth.users`. Declared only so foreign keys can reference it; it is NOT
 * exported from `schema/index.ts`, so drizzle-kit never tries to create or alter it.
 */
export const authSchema = pgSchema("auth");

export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey(),
});
