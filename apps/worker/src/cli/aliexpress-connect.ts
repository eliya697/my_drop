/**
 * Connects the AliExpress buyer account whose orders and catalog access the store uses.
 *
 *   pnpm aliexpress:connect              print the authorization URL
 *   pnpm aliexpress:connect --code XYZ   exchange the code from the callback and store the tokens
 *   pnpm aliexpress:connect --status     show which account is connected and when tokens expire
 *
 * Tokens are stored encrypted (AES-256-GCM) in `integration_credentials`; they are never printed.
 */
import { parseArgs } from "node:util";
import { AliExpressClient, buildAuthorizeUrl, createToken } from "@dropship/adapters";
import { loadWorkerEnv } from "@dropship/config";
import { createDb } from "@dropship/db";
import { aliexpressCredentialStore } from "../integrations/aliexpress";

const out = (line = "") => process.stdout.write(`${line}\n`);

async function main() {
  const { values } = parseArgs({ options: { code: { type: "string" }, status: { type: "boolean" } } });
  const env = loadWorkerEnv();
  const missing = (
    ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET", "CREDENTIALS_ENCRYPTION_KEY"] as const
  ).filter((k) => !env[k]);
  if (missing.length) throw new Error(`set ${missing.join(", ")} in .env first`);

  if (!values.code && !values.status) {
    if (!env.ALIEXPRESS_REDIRECT_URI)
      throw new Error("set ALIEXPRESS_REDIRECT_URI (the callback registered in the app console)");
    out("1. Open this URL while signed in to the AliExpress account that will place orders:");
    out();
    out(
      `   ${buildAuthorizeUrl({ appKey: env.ALIEXPRESS_APP_KEY!, redirectUri: env.ALIEXPRESS_REDIRECT_URI })}`,
    );
    out();
    out("2. After approving, copy the `code` from the page you are redirected to (valid for 30 minutes).");
    out("3. Run:  pnpm aliexpress:connect --code <code>");
    return;
  }

  const database = createDb(env.DIRECT_DATABASE_URL, { max: 1, applicationName: "aliexpress-connect" });
  try {
    const store = aliexpressCredentialStore(database.db, env.CREDENTIALS_ENCRYPTION_KEY!);

    if (values.code) {
      const client = new AliExpressClient({
        appKey: env.ALIEXPRESS_APP_KEY!,
        appSecret: env.ALIEXPRESS_APP_SECRET!,
      });
      const tokens = await createToken(client, values.code);
      await store.save(tokens);
      out(`Connected AliExpress account ${tokens.account ?? tokens.sellerId ?? "(unknown)"}.`);
    }

    const current = await store.load();
    if (!current) {
      out("No AliExpress account is connected.");
      return;
    }
    out(`Account:         ${current.account ?? current.sellerId ?? "(unknown)"}`);
    out(`Access token:    expires ${new Date(current.accessExpiresAt).toISOString()}`);
    out(
      `Refresh token:   ${current.refreshExpiresAt > 0 ? `expires ${new Date(current.refreshExpiresAt).toISOString()}` : "not refreshable"}`,
    );
  } finally {
    await database.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`aliexpress:connect failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
