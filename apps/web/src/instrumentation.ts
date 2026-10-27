/**
 * Runs once when a Next.js server instance boots. Validating here makes a misconfigured
 * deployment fail immediately at startup instead of on the first request that needs a secret.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadWebServerEnv } = await import("@dropship/config");
  const { loadPublicEnv } = await import("@dropship/config/public");
  loadWebServerEnv();
  loadPublicEnv();
}
