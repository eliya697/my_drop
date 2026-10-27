import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvValidationError, loadMigrationEnv, loadWorkerEnv, REQUIRED_IN_PRODUCTION } from "./index";
import { loadPublicEnv } from "./public";

const DB = {
  DATABASE_URL: "postgresql://u:p@localhost:6543/postgres",
  DIRECT_DATABASE_URL: "postgresql://u:p@localhost:5432/postgres",
};

const PRODUCTION_SECRETS = {
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789",
  ANTHROPIC_API_KEY: "sk-ant-api03-0123456789abcdef",
  STRIPE_SECRET_KEY: "sk_live_0123456789abcdef",
  STRIPE_WEBHOOK_SECRET: "whsec_0123456789abcdef",
  ALIEXPRESS_APP_KEY: "123456",
  ALIEXPRESS_APP_SECRET: "0123456789abcdef0123",
  RESEND_API_KEY: "re_0123456789abcdef",
  EMAIL_FROM: "Store <orders@example.com>",
  SENTRY_DSN: "https://key@o1.ingest.sentry.io/1",
  CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    if (err instanceof EnvValidationError) return err.issues;
    throw err;
  }
  throw new Error("expected EnvValidationError");
}

describe("loadWorkerEnv", () => {
  it("applies defaults in development with only database URLs set", () => {
    const env = loadWorkerEnv(DB);
    expect(env.APP_ENV).toBe("development");
    expect(env.HEALTH_PORT).toBe(8080);
    expect(env.WORKER_PGBOSS_SCHEMA).toBe("pgboss");
    expect(env.FEATURE_AUTO_PUBLISH).toBe(false);
    expect(env.FEATURE_DRY_RUN_FULFILLMENT).toBe(true);
    expect(Object.isFrozen(env)).toBe(true);
  });

  it("reports every missing database URL", () => {
    const keys = issuesOf(() => loadWorkerEnv({})).map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["DATABASE_URL", "DIRECT_DATABASE_URL"]));
  });

  it("rejects non-postgres database URLs", () => {
    const issues = issuesOf(() => loadWorkerEnv({ ...DB, DATABASE_URL: "mysql://u:p@h/db" }));
    expect(issues[0]?.key).toBe("DATABASE_URL");
  });

  it("requires every integration secret in production", () => {
    const keys = issuesOf(() => loadWorkerEnv({ ...DB, APP_ENV: "production" })).map((i) => i.key);
    expect(keys.sort()).toEqual([...REQUIRED_IN_PRODUCTION].sort());
  });

  it("accepts a complete production environment", () => {
    const env = loadWorkerEnv({ ...DB, ...PRODUCTION_SECRETS, APP_ENV: "production" });
    expect(env.STRIPE_SECRET_KEY).toBe(PRODUCTION_SECRETS.STRIPE_SECRET_KEY);
  });

  it("rejects a Stripe test key in production", () => {
    const issues = issuesOf(() =>
      loadWorkerEnv({
        ...DB,
        ...PRODUCTION_SECRETS,
        APP_ENV: "production",
        STRIPE_SECRET_KEY: "sk_test_0123456789",
      }),
    );
    expect(issues).toEqual([{ key: "STRIPE_SECRET_KEY", message: "production must use a live key" }]);
  });

  it("rejects a Stripe live key outside production", () => {
    const issues = issuesOf(() =>
      loadWorkerEnv({ ...DB, APP_ENV: "staging", STRIPE_SECRET_KEY: "sk_live_0123456789abcdef" }),
    );
    expect(issues[0]?.key).toBe("STRIPE_SECRET_KEY");
  });

  it("treats empty strings as unset", () => {
    const env = loadWorkerEnv({ ...DB, ANTHROPIC_API_KEY: "", SENTRY_DSN: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("parses booleans strictly", () => {
    expect(loadWorkerEnv({ ...DB, FEATURE_AUTO_PUBLISH: "false" }).FEATURE_AUTO_PUBLISH).toBe(false);
    expect(loadWorkerEnv({ ...DB, FEATURE_AUTO_PUBLISH: "1" }).FEATURE_AUTO_PUBLISH).toBe(true);
    expect(issuesOf(() => loadWorkerEnv({ ...DB, FEATURE_AUTO_PUBLISH: "maybe" }))[0]?.key).toBe(
      "FEATURE_AUTO_PUBLISH",
    );
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    const issues = issuesOf(() =>
      loadWorkerEnv({ ...DB, CREDENTIALS_ENCRYPTION_KEY: randomBytes(16).toString("base64") }),
    );
    expect(issues[0]?.key).toBe("CREDENTIALS_ENCRYPTION_KEY");
  });

  it("never includes secret values in the error message", () => {
    const secret = "sk_live_super_secret_value_123";
    try {
      loadWorkerEnv({ ...DB, APP_ENV: "development", STRIPE_SECRET_KEY: secret });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });
});

describe("loadMigrationEnv", () => {
  it("needs only database settings", () => {
    expect(loadMigrationEnv(DB).DIRECT_DATABASE_URL).toBe(DB.DIRECT_DATABASE_URL);
  });
});

describe("loadPublicEnv", () => {
  it("normalizes the site URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com/";
    expect(loadPublicEnv().NEXT_PUBLIC_SITE_URL).toBe("https://shop.example.com");
  });
});
