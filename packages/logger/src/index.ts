import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

export const REDACTED = "[REDACTED]";

/**
 * Field names that hold personal data or credentials. Matched case-sensitively in both the
 * camelCase and snake_case spellings used across the codebase and third-party payloads.
 */
export const SENSITIVE_KEYS = [
  "email",
  "customerEmail",
  "customer_email",
  "phone",
  "phoneNumber",
  "phone_number",
  "address",
  "addresses",
  "shippingAddress",
  "shipping_address",
  "billingAddress",
  "billing_address",
  "line1",
  "line2",
  "fullName",
  "full_name",
  "name_on_card",
  "password",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "apiKey",
  "api_key",
  "secret",
  "clientSecret",
  "client_secret",
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "stripe-signature",
] as const;

/** pino's redaction does not support recursive wildcards, so each depth is listed explicitly. */
const MAX_DEPTH = 4;

export function buildRedactPaths(keys: readonly string[] = SENSITIVE_KEYS, depth = MAX_DEPTH): string[] {
  const paths: string[] = [];
  for (const key of keys) {
    const isIdentifier = /^[A-Za-z_$][\w$]*$/.test(key);
    for (let level = 0; level <= depth; level++) {
      const prefix = Array.from({ length: level }, () => "*").join(".");
      if (isIdentifier) paths.push(prefix ? `${prefix}.${key}` : key);
      else paths.push(`${prefix}["${key}"]`);
    }
  }
  return paths;
}

export type CreateLoggerOptions = {
  service: string;
  level?: LoggerOptions["level"];
  appEnv?: string;
  /** Additional sensitive keys specific to one service. */
  extraRedactKeys?: readonly string[];
  /** Write to a custom stream (tests, log shippers). Defaults to stdout. */
  destination?: DestinationStream;
};

export function createLogger(opts: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? "info",
    base: { service: opts.service, env: opts.appEnv ?? "development" },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "msg",
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: buildRedactPaths([...SENSITIVE_KEYS, ...(opts.extraRedactKeys ?? [])]),
      censor: REDACTED,
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
