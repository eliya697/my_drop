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

export const workerEnvSchema = coreSchema
  .merge(databaseSchema)
  .merge(workerSchema)
  .merge(featureSchema)
  .merge(integrationsSchema)
  .superRefine(enforceStageRules);
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
