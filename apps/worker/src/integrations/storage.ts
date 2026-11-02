import { LocalStorage, R2Storage, type ObjectStorage } from "@dropship/adapters";
import type { WorkerEnv } from "@dropship/config";

export function buildStorage(env: WorkerEnv): ObjectStorage {
  if (env.STORAGE_DRIVER === "r2") {
    // Presence of every R2_* value is enforced by the env schema when the driver is r2.
    return new R2Storage({
      accountId: env.R2_ACCOUNT_ID!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      bucket: env.R2_BUCKET!,
      publicBaseUrl: env.R2_PUBLIC_BASE_URL!,
    });
  }
  return new LocalStorage(env.LOCAL_STORAGE_DIR, env.LOCAL_STORAGE_PUBLIC_URL);
}
