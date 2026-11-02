import {
  AliExpressCatalog,
  AliExpressClient,
  TokenManager,
  type AliExpressTokenSet,
  type TokenStore,
} from "@dropship/adapters";
import type { WorkerEnv } from "@dropship/config";
import { CredentialStore, type Executor } from "@dropship/db";
import type { Logger } from "@dropship/logger";

export const ALIEXPRESS_CREDENTIALS_PROVIDER = "aliexpress";

export function aliexpressCredentialStore(
  db: Executor,
  encryptionKey: string,
): TokenStore & {
  save(tokens: AliExpressTokenSet): Promise<void>;
} {
  return new CredentialStore<AliExpressTokenSet>(
    db,
    { provider: ALIEXPRESS_CREDENTIALS_PROVIDER, encryptionKey },
    (tokens) => new Date(tokens.accessExpiresAt),
  );
}

export type AliExpressIntegration = {
  client: AliExpressClient;
  tokens: TokenManager;
  catalog: AliExpressCatalog;
};

export type AliExpressConfig = Pick<
  WorkerEnv,
  | "ALIEXPRESS_APP_KEY"
  | "ALIEXPRESS_APP_SECRET"
  | "CREDENTIALS_ENCRYPTION_KEY"
  | "ALIEXPRESS_REQUESTS_PER_SECOND"
  | "IMPORT_SHIP_TO"
>;

/** Builds the AliExpress stack, or returns the names of the missing settings. */
export function buildAliExpress(
  env: AliExpressConfig,
  db: Executor,
  logger: Logger,
): AliExpressIntegration | { missing: string[] } {
  const missing = (
    ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET", "CREDENTIALS_ENCRYPTION_KEY"] as const
  ).filter((k) => !env[k]);
  if (missing.length > 0) return { missing };

  const client = new AliExpressClient({
    appKey: env.ALIEXPRESS_APP_KEY!,
    appSecret: env.ALIEXPRESS_APP_SECRET!,
    requestsPerSecond: env.ALIEXPRESS_REQUESTS_PER_SECOND,
    burst: Math.max(1, Math.ceil(env.ALIEXPRESS_REQUESTS_PER_SECOND)),
    onCircuitStateChange: (state) =>
      (state === "open" ? logger.error.bind(logger) : logger.info.bind(logger))(
        { state },
        "aliexpress circuit breaker",
      ),
  });
  const tokens = new TokenManager(client, aliexpressCredentialStore(db, env.CREDENTIALS_ENCRYPTION_KEY!));
  const catalog = new AliExpressCatalog(client, tokens, {
    currency: "USD",
    defaultShipTo: env.IMPORT_SHIP_TO,
  });
  return { client, tokens, catalog };
}
