import { z } from "zod";
import { aes256Key, booleanish, httpUrl, optional, port, postgresUrl, prefixed } from "./primitives";

export const APP_ENVS = ["development", "test", "staging", "production"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/**
 * APP_ENV is the deployment stage. NODE_ENV is not used for that: `next build` always forces
 * NODE_ENV=production, even for staging and preview builds.
 */
export const coreSchema = z.object({
  APP_ENV: z.enum(APP_ENVS).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export const databaseSchema = z.object({
  /** Pooled connection (Supabase transaction pooler, port 6543) for request-path queries. */
  DATABASE_URL: postgresUrl,
  /** Direct/session connection (port 5432) for migrations and pg-boss, which need session features. */
  DIRECT_DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

export const workerSchema = z.object({
  HEALTH_PORT: port.default(8080),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  WORKER_PGBOSS_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, "must be a lowercase SQL identifier")
    .default("pgboss"),
  /** Readiness fails when no heartbeat job has completed within this window. */
  WORKER_HEARTBEAT_STALE_SECONDS: z.coerce.number().int().min(120).default(300),
  /** Readiness fails when any job has been active longer than this. */
  WORKER_STUCK_JOB_MINUTES: z.coerce.number().int().min(1).default(30),
});

export const importSchema = z.object({
  /** Destination country for prices, stock and shipping quotes. */
  IMPORT_SHIP_TO: z
    .string()
    .regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code")
    .default("IL"),
  /** SKUs whose fastest tracked shipping is slower than this are imported inactive. */
  IMPORT_MAX_SHIPPING_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Client-side rate limit for the AliExpress gateway. Keep at or below the app's quota. */
  ALIEXPRESS_REQUESTS_PER_SECOND: z.coerce.number().positive().max(100).default(5),
});

export const featureSchema = z.object({
  FEATURE_AUTO_PUBLISH: booleanish.default("false"),
  /** When true, fulfillment logs the supplier request instead of sending it. */
  FEATURE_DRY_RUN_FULFILLMENT: booleanish.default("true"),
});

/**
 * Third-party credentials. They are optional while developing, but every key in
 * `REQUIRED_IN_PRODUCTION` must be present when APP_ENV=production, and Stripe keys must match
 * the stage (live keys only in production, test keys everywhere else).
 */
export const integrationsSchema = z.object({
  SUPABASE_URL: optional(httpUrl),
  SUPABASE_SERVICE_ROLE_KEY: optional(z.string().min(20)),

  ANTHROPIC_API_KEY: optional(prefixed("sk-ant-")),
  ANTHROPIC_DAILY_BUDGET_USD: z.coerce.number().positive().default(25),

  STRIPE_SECRET_KEY: optional(prefixed(["sk_live_", "sk_test_", "rk_live_", "rk_test_"])),
  STRIPE_WEBHOOK_SECRET: optional(prefixed("whsec_")),

  ALIEXPRESS_APP_KEY: optional(z.string().min(4)),
  ALIEXPRESS_APP_SECRET: optional(z.string().min(16)),
  /** Callback URL registered in the AliExpress app console (receives the OAuth `code`). */
  ALIEXPRESS_REDIRECT_URI: optional(httpUrl),

  STORAGE_DRIVER: z.enum(["local", "r2"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().min(1).default(".storage"),
  LOCAL_STORAGE_PUBLIC_URL: httpUrl.default("http://localhost:3000/media"),
  R2_ACCOUNT_ID: optional(z.string().regex(/^[a-f0-9]{32}$/, "must be a 32-char hex Cloudflare account id")),
  R2_ACCESS_KEY_ID: optional(z.string().min(16)),
  R2_SECRET_ACCESS_KEY: optional(z.string().min(32)),
  R2_BUCKET: optional(z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, "invalid bucket name")),
  R2_PUBLIC_BASE_URL: optional(httpUrl),

  RESEND_API_KEY: optional(prefixed("re_")),
  EMAIL_FROM: optional(z.string().min(3)),

  SENTRY_DSN: optional(httpUrl),

  CREDENTIALS_ENCRYPTION_KEY: optional(aes256Key),
});

export const REQUIRED_IN_PRODUCTION = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ALIEXPRESS_APP_KEY",
  "ALIEXPRESS_APP_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "SENTRY_DSN",
  "CREDENTIALS_ENCRYPTION_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_BASE_URL",
] as const satisfies readonly (keyof z.infer<typeof integrationsSchema>)[];

type StageAware = { APP_ENV: AppEnv } & Partial<z.infer<typeof integrationsSchema>>;

export function enforceStageRules(env: StageAware, ctx: z.RefinementCtx) {
  if (env.APP_ENV === "production") {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "required when APP_ENV=production",
        });
      }
    }
  }

  if (env.APP_ENV === "production" && env.STORAGE_DRIVER === "local") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["STORAGE_DRIVER"],
      message: "production must use r2 (local disk is not shared or durable)",
    });
  }
  if (env.STORAGE_DRIVER === "r2" && env.APP_ENV !== "production") {
    for (const key of [
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "R2_PUBLIC_BASE_URL",
    ] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "required when STORAGE_DRIVER=r2",
        });
      }
    }
  }

  const stripeKey = env.STRIPE_SECRET_KEY;
  if (stripeKey) {
    const isLive = /^(sk|rk)_live_/.test(stripeKey);
    if (env.APP_ENV === "production" && !isLive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STRIPE_SECRET_KEY"],
        message: "production must use a live key",
      });
    }
    if (env.APP_ENV !== "production" && isLive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STRIPE_SECRET_KEY"],
        message: `live keys are not allowed when APP_ENV=${env.APP_ENV}`,
      });
    }
  }
}

/** Market inputs for the pricing engine (see packages/core/src/pricing.ts). */
export const pricingSchema = z.object({
  /** ILS per 1 USD. Update when the rate moves; prices are recomputed on the next pricing run. */
  PRICING_USD_ILS_RATE: optional(z.coerce.number().min(1).max(10)),
  PRICING_FX_BUFFER: z.coerce.number().min(0).max(0.2).default(0.03),
  PRICING_VAT_RATE: z.coerce.number().min(0).max(0.5).default(0.18),
  /** Card processing fee as a fraction of the charged amount. Match your Stripe pricing. */
  PRICING_PAYMENT_FEE_RATE: z.coerce.number().min(0).max(0.1).default(0.029),
  /** Fixed card processing fee per charge, ILS agorot. */
  PRICING_PAYMENT_FEE_FIXED_MINOR: z.coerce.number().int().min(0).max(1000).default(120),
});

export const aiSchema = z.object({
  /**
   * realtime: enrich each product right after import (one API call each);
   * batch: collect imported products and submit them via the Batches API (50% cheaper, ≤24h);
   * off: leave products in `imported` until someone queues them.
   */
  AI_ENRICH_MODE: z.enum(["realtime", "batch", "off"]).default("realtime"),
  AI_BATCH_MAX_ITEMS: z.coerce.number().int().min(1).max(10_000).default(200),
});

export const workerEnvSchema = coreSchema
  .merge(databaseSchema)
  .merge(workerSchema)
  .merge(importSchema)
  .merge(pricingSchema)
  .merge(aiSchema)
  .merge(featureSchema)
  .merge(integrationsSchema)
  .superRefine((env, ctx) => {
    enforceStageRules(env, ctx);
    if (env.APP_ENV === "production" && env.PRICING_USD_ILS_RATE === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PRICING_USD_ILS_RATE"],
        message: "required when APP_ENV=production",
      });
    }
  });
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const webServerEnvSchema = coreSchema
  .merge(databaseSchema)
  .merge(featureSchema)
  .merge(integrationsSchema)
  .superRefine(enforceStageRules);
export type WebServerEnv = z.infer<typeof webServerEnvSchema>;

/** Used by migrations and drizzle-kit, which only need database access. */
export const migrationEnvSchema = coreSchema.merge(databaseSchema);
export type MigrationEnv = z.infer<typeof migrationEnvSchema>;
