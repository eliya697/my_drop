import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Arbitrary constant identifying the migration lock; any process using it serializes with us. */
const MIGRATION_LOCK_KEY = 72_616_001;

/**
 * Applies pending migrations over a single direct (non-pooled) connection. A session-level
 * advisory lock serializes concurrent runners (parallel deploys, parallel test files): the
 * second waits, then finds nothing left to apply.
 */
export async function runMigrations(directUrl: string): Promise<void> {
  const sql = postgres(directUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  const { loadMigrationEnv } = await import("@dropship/config");
  const env = loadMigrationEnv();
  const started = Date.now();
  try {
    await runMigrations(env.DIRECT_DATABASE_URL);
    process.stdout.write(`migrations applied in ${Date.now() - started}ms\n`);
  } catch (err) {
    process.stderr.write(`migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
