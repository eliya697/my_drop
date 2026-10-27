import { parseEnv } from "./parse";
import {
  migrationEnvSchema,
  webServerEnvSchema,
  workerEnvSchema,
  type MigrationEnv,
  type WebServerEnv,
  type WorkerEnv,
} from "./schemas";

export { EnvValidationError, parseEnv } from "./parse";
export * from "./schemas";

export const loadWorkerEnv = (source?: Record<string, string | undefined>): WorkerEnv =>
  parseEnv(workerEnvSchema, source, "worker");

export const loadWebServerEnv = (source?: Record<string, string | undefined>): WebServerEnv =>
  parseEnv(webServerEnvSchema, source, "web (server)");

export const loadMigrationEnv = (source?: Record<string, string | undefined>): MigrationEnv =>
  parseEnv(migrationEnvSchema, source, "migrations");
