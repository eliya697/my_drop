import { defineConfig } from "drizzle-kit";

// `generate` and `check` work offline; `migrate`/`studio` need DIRECT_DATABASE_URL (session
// connection — Supabase's transaction pooler does not support the statements migrations use).
const url = process.env.DIRECT_DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  schemaFilter: ["public"],
  strict: true,
  verbose: true,
  ...(url ? { dbCredentials: { url } } : {}),
});
