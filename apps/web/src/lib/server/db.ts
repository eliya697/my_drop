import "server-only";
import { createDb, type DbHandle } from "@dropship/db";
import { serverEnv } from "./env";

// One pool per server instance. Survives Next.js dev hot reloads via globalThis.
const globalForDb = globalThis as unknown as { __dropshipDb?: DbHandle };

export function getDb(): DbHandle {
  if (!globalForDb.__dropshipDb) {
    const env = serverEnv();
    globalForDb.__dropshipDb = createDb(env.DATABASE_URL, {
      max: env.DATABASE_POOL_MAX,
      prepare: false,
      applicationName: "dropship-web",
    });
  }
  return globalForDb.__dropshipDb;
}
