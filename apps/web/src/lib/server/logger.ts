import "server-only";
import { createLogger } from "@dropship/logger";
import { serverEnv } from "./env";

const env = serverEnv();

export const logger = createLogger({ service: "web", level: env.LOG_LEVEL, appEnv: env.APP_ENV });
