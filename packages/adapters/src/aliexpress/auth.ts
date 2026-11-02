import { SupplierAuthError } from "@dropship/core";
import type { AliExpressClient, JsonObject } from "./client";
import { SUPPLIER } from "./errors";
import { str } from "./parse";

/** Persisted OAuth state for one authorized AliExpress account. */
export type AliExpressTokenSet = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  /** Epoch ms; 0 means the token cannot be refreshed (platform rule: refresh_expires_in = 0). */
  refreshExpiresAt: number;
  account?: string;
  sellerId?: string;
  obtainedAt: number;
};

/**
 * URL the account owner opens to grant the app access (official "Seller authorization
 * introduction" doc). The resulting `code` expires in 30 minutes.
 */
export function buildAuthorizeUrl(opts: {
  appKey: string;
  redirectUri: string;
  gateway?: string;
  state?: string;
}): string {
  const url = new URL("/oauth/authorize", opts.gateway ?? "https://api-sg.aliexpress.com");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("force_auth", "true");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("client_id", opts.appKey);
  if (opts.state) url.searchParams.set("state", opts.state);
  return url.toString();
}

/** Exchanges an authorization code for tokens (`/auth/token/create`). */
export async function createToken(
  client: AliExpressClient,
  code: string,
  now = Date.now(),
): Promise<AliExpressTokenSet> {
  return parseTokenResponse(await client.system("/auth/token/create", { code: code.trim() }), now);
}

/**
 * Refreshes tokens (`/auth/token/refresh`). The platform rotates the refresh token: the returned
 * set REPLACES the stored one and must be persisted before it is used.
 */
export async function refreshToken(
  client: AliExpressClient,
  current: AliExpressTokenSet,
  now = Date.now(),
): Promise<AliExpressTokenSet> {
  if (!canRefresh(current, now)) {
    throw new SupplierAuthError(SUPPLIER, "refresh token expired; the account must be re-authorized");
  }
  return parseTokenResponse(
    await client.system("/auth/token/refresh", { refresh_token: current.refreshToken }),
    now,
  );
}

export const canRefresh = (tokens: AliExpressTokenSet, now = Date.now()): boolean =>
  tokens.refreshExpiresAt > now;

/**
 * Token fields per the official sample: access_token, refresh_token, expire_time (epoch ms),
 * expires_in (s), refresh_token_valid_time (epoch ms), refresh_expires_in (s), account, seller_id.
 * Absolute timestamps are preferred; relative durations are the fallback.
 */
export function parseTokenResponse(body: JsonObject, now: number): AliExpressTokenSet {
  const accessToken = str(body.access_token);
  const refresh = str(body.refresh_token);
  if (!accessToken || !refresh)
    throw new SupplierAuthError(SUPPLIER, "token response is missing access_token/refresh_token");

  const absolute = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > now ? n : null;
  };
  const relative = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? now + n * 1000 : null;
  };

  const accessExpiresAt = absolute(body.expire_time) ?? relative(body.expires_in);
  if (accessExpiresAt === null) throw new SupplierAuthError(SUPPLIER, "token response has no usable expiry");
  const refreshExpiresAt =
    Number(body.refresh_expires_in) === 0
      ? 0
      : (absolute(body.refresh_token_valid_time) ?? relative(body.refresh_expires_in) ?? 0);

  return {
    accessToken,
    refreshToken: refresh,
    accessExpiresAt,
    refreshExpiresAt,
    account: str(body.account),
    sellerId: str(body.seller_id) ?? str(body.user_id),
    obtainedAt: now,
  };
}
