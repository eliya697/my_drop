import "server-only";
import { loadWebServerEnv, type WebServerEnv } from "@dropship/config";

let cached: WebServerEnv | undefined;

/** Server-only configuration. Throws (listing key names, never values) if anything is invalid. */
export function serverEnv(): WebServerEnv {
  cached ??= loadWebServerEnv();
  return cached;
}
