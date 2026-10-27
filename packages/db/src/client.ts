import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema/index";

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type CreateDbOptions = {
  /** Max pool size. Keep small on serverless (each instance holds its own pool). */
  max?: number;
  applicationName?: string;
  /**
   * Must be false behind Supabase's transaction pooler (port 6543), which cannot hold prepared
   * statements across transactions. Safe to enable on a direct/session connection.
   */
  prepare?: boolean;
};

export type DbHandle = {
  db: Database;
  sql: Sql;
  close: (timeoutSeconds?: number) => Promise<void>;
};

export function createDb(url: string, opts: CreateDbOptions = {}): DbHandle {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    prepare: opts.prepare ?? false,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    connection: { application_name: opts.applicationName ?? "dropship" },
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    sql,
    close: (timeoutSeconds = 5) => sql.end({ timeout: timeoutSeconds }),
  };
}

/** Cheap connectivity probe for readiness checks. Rejects if the database does not answer in time. */
export async function pingDatabase(sql: Sql, timeoutMs = 2_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`database ping timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([sql`select 1`, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
