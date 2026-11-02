import { SupplierAuthError } from "@dropship/core";
import { canRefresh, refreshToken, type AliExpressTokenSet } from "./auth";
import type { AliExpressClient } from "./client";
import { SUPPLIER } from "./errors";

/**
 * Persistence for the token set. `update` must hold an exclusive lock for the duration of `fn`
 * (e.g. SELECT … FOR UPDATE), so two workers never refresh concurrently — the platform rotates
 * refresh tokens, and a lost update would strand the account.
 */
export interface TokenStore {
  load(): Promise<AliExpressTokenSet | null>;
  update(
    fn: (current: AliExpressTokenSet | null) => Promise<AliExpressTokenSet>,
  ): Promise<AliExpressTokenSet>;
}

/** Refresh this long before expiry (the platform recommends 30 minutes). */
export const REFRESH_MARGIN_MS = 30 * 60 * 1000;

/**
 * Hands out a valid access token, refreshing under the store's lock when it is about to expire.
 * The token is cached in memory until the refresh margin.
 */
export class TokenManager {
  private cached: AliExpressTokenSet | null = null;

  constructor(
    private readonly client: AliExpressClient,
    private readonly store: TokenStore,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && !this.needsRefresh(this.cached)) return this.cached.accessToken;

    const stored = await this.store.load();
    if (!stored)
      throw new SupplierAuthError(SUPPLIER, "no AliExpress account connected; run `pnpm aliexpress:connect`");
    if (!this.needsRefresh(stored)) {
      this.cached = stored;
      return stored.accessToken;
    }

    const fresh = await this.store.update(async (current) => {
      if (!current) throw new SupplierAuthError(SUPPLIER, "AliExpress credentials were removed");
      // Another worker may have refreshed while we waited for the lock.
      if (!this.needsRefresh(current)) return current;
      if (!canRefresh(current, this.now())) {
        if (current.accessExpiresAt > this.now()) return current; // still usable; re-authorize soon
        throw new SupplierAuthError(
          SUPPLIER,
          "AliExpress authorization expired; run `pnpm aliexpress:connect`",
        );
      }
      return refreshToken(this.client, current, this.now());
    });
    this.cached = fresh;
    return fresh.accessToken;
  }

  /** Drops the in-memory copy, e.g. after the gateway rejected the token. */
  invalidate(): void {
    this.cached = null;
  }

  private needsRefresh(tokens: AliExpressTokenSet): boolean {
    return tokens.accessExpiresAt - this.now() <= REFRESH_MARGIN_MS;
  }
}
