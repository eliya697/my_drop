export * from "./schema/index";
export {
  createDb,
  pingDatabase,
  type CreateDbOptions,
  type Database,
  type DbHandle,
  type Schema,
  type Transaction,
} from "./client";
export { sql } from "drizzle-orm";
// Migrations are exposed via "@dropship/db/migrate" only, so bundlers (Next.js) never pull in
// the migrator or its filesystem paths.
