import { readFileSync } from "node:fs";
import {
  NoEligibleVariantError,
  SupplierAuthError,
  SupplierNotFoundError,
  SupplierRateLimitError,
  SupplierRejectedError,
  SupplierUnavailableError,
} from "@dropship/core";
import { describe, expect, it } from "vitest";
import { fakeClock, fakeFetch, json, type RecordedRequest } from "../test-utils";
import {
  buildAuthorizeUrl,
  createToken,
  parseTokenResponse,
  refreshToken,
  type AliExpressTokenSet,
} from "./auth";
import { AliExpressCatalog } from "./catalog";
import { AliExpressClient } from "./client";
import { normalizeFreight, normalizeProduct } from "./normalize";
import { MalformedPayloadError, parseLooseCount, parseMoneyMinor, unwrapList, unwrapResponse } from "./parse";
import { InvalidProductReferenceError, parseAliExpressProductId } from "./product-id";
import { signRequest } from "./sign";
import { REFRESH_MARGIN_MS, TokenManager, type TokenStore } from "./token-manager";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
const PRODUCT = fixture("product-get");
const FREIGHT = fixture("freight-query");

describe("signRequest — official test vectors", () => {
  it("signs a business API call (HTTP request sample, case 1)", () => {
    expect(
      signRequest(
        {
          access_token: "test",
          aliexpress_category_id: "200135143",
          app_key: "123456",
          method: "aliexpress.logistics.redefining.getonlinelogisticsinfo",
          sign_method: "sha256",
          timestamp: "1517820392000",
        },
        "helloworld",
      ),
    ).toBe("F7F7926B67316C9D1E8E15F7E66940ED3059B1638C497D77973F30046EFB5BBB");
  });

  it("signs a system API call with the path prefix (case 2)", () => {
    expect(
      signRequest(
        {
          app_key: "12345678",
          code: "3_500102_JxZ05Ux3cnnSSUm6dCxYg6Q26",
          sign_method: "sha256",
          timestamp: "1517820392000",
        },
        "helloworld",
        "/auth/token/create",
      ),
    ).toBe("35607762342831B6A417A0DED84B79C05FEFBF116969C48AD6DC00279A9F4D81");
  });

  it("ignores `sign` and empty values, and is order-independent", () => {
    const a = signRequest({ b: "2", a: "1", empty: "", sign: "X" }, "s");
    const b = signRequest({ a: "1", b: "2" }, "s");
    expect(a).toBe(b);
  });
});

describe("parsers", () => {
  it.each([
    ["3.94", 394],
    ["12", 1200],
    ["0.5", 50],
    ["0", 0],
    [7.1, 710],
  ])("parseMoneyMinor(%j) = %i", (input, expected) => {
    expect(parseMoneyMinor(input, "f")).toBe(expected);
  });

  it.each(["-1.00", "1.234", "US $1.99", "", "abc", null, "1,234.50"])(
    "rejects malformed money %j",
    (input) => {
      expect(() => parseMoneyMinor(input, "f")).toThrow(MalformedPayloadError);
    },
  );

  it("parses loose counts", () => {
    expect(parseLooseCount("1000+")).toBe(1000);
    expect(parseLooseCount("5,000+")).toBe(5000);
    expect(parseLooseCount("n/a")).toBeUndefined();
  });

  it("unwraps both list shapes", () => {
    expect(unwrapList([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(unwrapList({ ae_item_sku_info_d_t_o: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(unwrapList({ single: { a: 1 } })).toEqual([{ a: 1 }]);
    expect(unwrapList(undefined)).toEqual([]);
  });

  it("unwraps both response envelopes", () => {
    const inner = { result: { x: 1 } };
    expect(unwrapResponse({ aliexpress_ds_product_get_response: inner }, "aliexpress.ds.product.get")).toBe(
      inner,
    );
    expect(unwrapResponse(inner, "aliexpress.ds.product.get")).toBe(inner);
  });
});

describe("normalizeProduct", () => {
  const product = normalizeProduct(PRODUCT.result as Record<string, unknown>, "1005003784285827", PRODUCT);

  it("maps the official example", () => {
    expect(product).toMatchObject({
      supplier: "aliexpress",
      externalId: "1005003784285827",
      title: expect.stringContaining("FUQIAN"),
      sellerId: "4874072",
      available: true,
      rating: 4.8,
      ordersCount: 1000,
      descriptionRaw: "<div>This is a product</div>",
    });
  });

  it("prefers the sale price and the seller's option labels", () => {
    expect(product.variants[0]).toEqual({
      skuId: "12000027158136202",
      options: { "Lenses Color": "Black Green", "Lenses Optical Attribute": "Polarized" },
      unitCost: { amountMinor: 394, currency: "USD" },
      stock: 57,
      imageUrl: "https://ae04.alicdn.com/kf/Hba46f8222fdf4440a271134f8ce2ca2aB.jpg",
    });
  });

  it("falls back to sku_price and generic option values", () => {
    expect(product.variants[1]).toMatchObject({
      unitCost: { amountMinor: 410, currency: "USD" },
      options: { "Lenses Color": "black" },
      stock: 0,
    });
  });

  it("deduplicates images and drops empty entries", () => {
    expect(product.images).toEqual([
      "https://ae04.alicdn.com/kf/H551494696f2342edbeee5d2f288f4d1cv.jpg",
      "https://ae04.alicdn.com/kf/H847c9c1b04614adfa20f042cc4490df6S.jpg",
    ]);
  });

  it("merges repeated attributes", () => {
    expect(product.attributes).toEqual({
      "Brand Name": "FUQIAN",
      "Lenses Optical Attribute": "Polarized, UV400",
    });
  });

  it("marks delisted products unavailable", () => {
    const result = structuredClone(PRODUCT.result) as Record<string, Record<string, unknown>>;
    result.ae_item_base_info_dto!.product_status_type = "offline";
    expect(normalizeProduct(result, "1", {}).available).toBe(false);
  });

  it("handles the wrapped (non-simplified) SKU list", () => {
    const result = structuredClone(PRODUCT.result) as Record<string, unknown>;
    result.ae_item_sku_info_dtos = { ae_item_sku_info_d_t_o: result.ae_item_sku_info_dtos };
    expect(normalizeProduct(result, "1", {}).variants).toHaveLength(2);
  });

  it("rejects a SKU with a malformed price instead of guessing", () => {
    const result = structuredClone(PRODUCT.result) as { ae_item_sku_info_dtos: Record<string, unknown>[] };
    result.ae_item_sku_info_dtos[0]!.offer_sale_price = "free";
    expect(() => normalizeProduct(result, "1", {})).toThrow(MalformedPayloadError);
  });
});

describe("normalizeFreight", () => {
  const quotes = normalizeFreight(FREIGHT.result as Record<string, unknown>, "sku-1");

  it("reads shipping_fee_cent as MAJOR units (US $1.99 → 199 cents)", () => {
    expect(quotes[0]).toEqual({
      skuId: "sku-1",
      method: "CAINIAO_FULFILLMENT_STD",
      carrier: "AliExpress Selection Standard",
      cost: { amountMinor: 199, currency: "USD" },
      daysMin: 20,
      daysMax: 40,
      tracked: true,
    });
  });

  it("prices free shipping at zero and keeps the tracking flag", () => {
    expect(quotes[1]).toMatchObject({
      method: "CAINIAO_SUPER_ECONOMY",
      cost: { amountMinor: 0 },
      tracked: false,
    });
  });

  it("skips options with a malformed fee", () => {
    expect(quotes.map((q) => q.method)).not.toContain("BROKEN_FEE");
  });
});

describe("parseAliExpressProductId", () => {
  it.each([
    ["1005006123456789", "1005006123456789"],
    ["https://www.aliexpress.com/item/1005006123456789.html?spm=a2g0o", "1005006123456789"],
    ["https://he.aliexpress.com/item/1005006123456789.html", "1005006123456789"],
    ["https://m.aliexpress.com/item/1005006123456789.html", "1005006123456789"],
    ["https://www.aliexpress.us/item/3256806123456789.html", "3256806123456789"],
    ["  https://aliexpress.ru/item/1005006123456789.html  ", "1005006123456789"],
  ])("%s → %s", (input, id) => {
    expect(parseAliExpressProductId(input)).toBe(id);
  });

  it.each([
    "https://a.aliexpress.com/_mKxyz",
    "https://evil.example.com/item/1005006123456789.html",
    "https://aliexpress.com.evil.io/item/1005006123456789.html",
    "javascript:alert(1)",
    "https://www.aliexpress.com/store/123",
    "12345",
  ])("rejects %s", (input) => {
    expect(() => parseAliExpressProductId(input)).toThrow(InvalidProductReferenceError);
  });
});

function makeClient(respond: (req: RecordedRequest) => Response | Promise<Response>, opts = {}) {
  const clock = fakeClock();
  const fetch = fakeFetch(respond);
  const client = new AliExpressClient({
    appKey: "12345678",
    appSecret: "helloworld",
    fetch,
    clock,
    random: () => 1,
    attempts: 3,
    circuitFailureThreshold: 3,
    ...opts,
  });
  return { client, fetch, clock };
}

describe("AliExpressClient", () => {
  it("sends a signed business call to /sync with the common parameters", async () => {
    const { client, fetch } = makeClient(() => json({ code: "0", result: { ok: true } }));
    await client.business("aliexpress.ds.product.get", { product_id: "1" }, { accessToken: "tok" });
    const req = fetch.calls[0]!;
    expect(req.url).toBe("https://api-sg.aliexpress.com/sync");
    expect(req.params).toMatchObject({
      method: "aliexpress.ds.product.get",
      app_key: "12345678",
      access_token: "tok",
      sign_method: "sha256",
      product_id: "1",
    });
    const { sign, ...rest } = req.params;
    expect(sign).toBe(signRequest(rest, "helloworld"));
  });

  it("sends system calls to /rest{path} with the path in the signature", async () => {
    const { client, fetch } = makeClient(() => json({ code: "0", access_token: "a" }));
    await client.system("/auth/token/create", { code: "c" });
    const req = fetch.calls[0]!;
    expect(req.url).toBe("https://api-sg.aliexpress.com/rest/auth/token/create");
    expect(req.params.method).toBeUndefined();
    const { sign, ...rest } = req.params;
    expect(sign).toBe(signRequest(rest, "helloworld", "/auth/token/create"));
  });

  it("retries ISP and 5xx failures, then succeeds", async () => {
    let n = 0;
    const { client, fetch } = makeClient(() =>
      ++n === 1
        ? new Response("down", { status: 503 })
        : n === 2
          ? json({ code: "isp.timeout", type: "ISP", message: "backend timeout" })
          : json({ code: "0" }),
    );
    await client.business("m", {}, { accessToken: "t" });
    expect(fetch.calls).toHaveLength(3);
  });

  it("does not retry an invalid access token", async () => {
    const { client, fetch } = makeClient(() =>
      json({ code: "IllegalAccessToken", type: "SYSTEM", message: "The specified access token is invalid" }),
    );
    await expect(client.business("m", {}, { accessToken: "bad" })).rejects.toBeInstanceOf(SupplierAuthError);
    expect(fetch.calls).toHaveLength(1);
  });

  it("classifies call-limit errors as rate limiting", async () => {
    const { client } = makeClient(
      () => json({ code: "ApiCallLimit", type: "SYSTEM", message: "call limited" }),
      { attempts: 1 },
    );
    await expect(client.business("m", {}, { accessToken: "t" })).rejects.toBeInstanceOf(
      SupplierRateLimitError,
    );
  });

  it("honors Retry-After on HTTP 429", async () => {
    let n = 0;
    const { client, clock } = makeClient(() =>
      ++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "3" } }) : json({ code: "0" }),
    );
    await client.business("m", {}, { accessToken: "t" });
    expect(clock.sleeps).toContain(3000);
  });

  it("maps network failures to SupplierUnavailableError", async () => {
    const { client } = makeClient(() => Promise.reject(new TypeError("fetch failed")), { attempts: 1 });
    await expect(client.business("m", {}, { accessToken: "t" })).rejects.toBeInstanceOf(
      SupplierUnavailableError,
    );
  });

  it("opens the circuit after sustained outages and stops calling", async () => {
    const { client, fetch } = makeClient(() => new Response("down", { status: 502 }), { attempts: 1 });
    for (let i = 0; i < 3; i++)
      await expect(client.business("m", {}, { accessToken: "t" })).rejects.toThrow();
    expect(client.circuitState).toBe("open");
    await expect(client.business("m", {}, { accessToken: "t" })).rejects.toThrow(/circuit open/);
    expect(fetch.calls).toHaveLength(3);
  });

  it("reports the legacy error_response envelope", async () => {
    const { client } = makeClient(() =>
      json({ error_response: { code: "15", msg: "Remote service error", type: "ISV" } }),
    );
    await expect(client.business("m", {}, { accessToken: "t" })).rejects.toBeInstanceOf(
      SupplierRejectedError,
    );
  });
});

describe("OAuth tokens", () => {
  const NOW = 1_700_000_000_000;
  const SAMPLE = {
    refresh_token_valid_time: NOW + 90 * 86_400_000,
    expire_time: NOW + 30 * 86_400_000,
    access_token: "50000000528VP2cq",
    refresh_token: "50001001928fJIbs",
    refresh_expires_in: 7_776_000,
    expires_in: 2_592_000,
    seller_id: "200042362",
    account: "test1234@126.com",
    code: "0",
  };

  it("builds the documented authorization URL", () => {
    const url = new URL(buildAuthorizeUrl({ appKey: "123", redirectUri: "https://shop.example.com/cb" }));
    expect(url.origin + url.pathname).toBe("https://api-sg.aliexpress.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      force_auth: "true",
      redirect_uri: "https://shop.example.com/cb",
      client_id: "123",
    });
  });

  it("parses absolute expiry timestamps from the sample token", () => {
    expect(parseTokenResponse(SAMPLE, NOW)).toEqual({
      accessToken: "50000000528VP2cq",
      refreshToken: "50001001928fJIbs",
      accessExpiresAt: SAMPLE.expire_time,
      refreshExpiresAt: SAMPLE.refresh_token_valid_time,
      account: "test1234@126.com",
      sellerId: "200042362",
      obtainedAt: NOW,
    });
  });

  it("falls back to relative durations", () => {
    const t = parseTokenResponse(
      { access_token: "a", refresh_token: "r", expires_in: 60, refresh_expires_in: 120 },
      NOW,
    );
    expect(t.accessExpiresAt).toBe(NOW + 60_000);
    expect(t.refreshExpiresAt).toBe(NOW + 120_000);
  });

  it("treats refresh_expires_in = 0 as non-refreshable", () => {
    expect(parseTokenResponse({ ...SAMPLE, refresh_expires_in: 0 }, NOW).refreshExpiresAt).toBe(0);
  });

  it("exchanges a code and refreshes through the system endpoints", async () => {
    const { client, fetch } = makeClient(() => json(SAMPLE));
    const created = await createToken(client, " code-1 ", NOW);
    expect(fetch.calls[0]!.params.code).toBe("code-1");
    await refreshToken(client, created, NOW);
    expect(fetch.calls[1]!.url).toMatch(/\/rest\/auth\/token\/refresh$/);
    expect(fetch.calls[1]!.params.refresh_token).toBe("50001001928fJIbs");
  });

  it("refuses to refresh with an expired refresh token", async () => {
    const { client } = makeClient(() => json(SAMPLE));
    const expired = { ...parseTokenResponse(SAMPLE, NOW), refreshExpiresAt: NOW - 1 };
    await expect(refreshToken(client, expired, NOW)).rejects.toBeInstanceOf(SupplierAuthError);
  });
});

describe("TokenManager", () => {
  const NOW = 1_700_000_000_000;
  const tokens = (accessExpiresAt: number, refreshExpiresAt = NOW + 86_400_000): AliExpressTokenSet => ({
    accessToken: `access-${accessExpiresAt}`,
    refreshToken: "refresh",
    accessExpiresAt,
    refreshExpiresAt,
    obtainedAt: NOW,
  });

  function memoryStore(
    initial: AliExpressTokenSet | null,
  ): TokenStore & { value: AliExpressTokenSet | null; updates: number } {
    const store = {
      value: initial,
      updates: 0,
      load: async () => store.value,
      update: async (fn: (c: AliExpressTokenSet | null) => Promise<AliExpressTokenSet>) => {
        store.updates++;
        store.value = await fn(store.value);
        return store.value;
      },
    };
    return store;
  }

  it("uses a fresh token without refreshing", async () => {
    const { client, fetch } = makeClient(() => json({}));
    const store = memoryStore(tokens(NOW + 2 * REFRESH_MARGIN_MS));
    const manager = new TokenManager(client, store, () => NOW);
    expect(await manager.getAccessToken()).toBe(`access-${NOW + 2 * REFRESH_MARGIN_MS}`);
    expect(fetch.calls).toHaveLength(0);
  });

  it("refreshes inside the margin and persists the rotated tokens", async () => {
    const { client } = makeClient(() =>
      json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 86_400,
        refresh_expires_in: 864_000,
      }),
    );
    const store = memoryStore(tokens(NOW + 60_000));
    const manager = new TokenManager(client, store, () => NOW);
    expect(await manager.getAccessToken()).toBe("new-access");
    expect(store.value?.refreshToken).toBe("new-refresh");
    // cached afterwards
    expect(await manager.getAccessToken()).toBe("new-access");
    expect(store.updates).toBe(1);
  });

  it("explains how to connect when no account is stored", async () => {
    const { client } = makeClient(() => json({}));
    await expect(new TokenManager(client, memoryStore(null), () => NOW).getAccessToken()).rejects.toThrow(
      /aliexpress:connect/,
    );
  });

  it("fails clearly when both tokens are expired", async () => {
    const { client } = makeClient(() => json({}));
    const manager = new TokenManager(client, memoryStore(tokens(NOW - 1, NOW - 1)), () => NOW);
    await expect(manager.getAccessToken()).rejects.toBeInstanceOf(SupplierAuthError);
  });
});

describe("AliExpressCatalog (contract over the official fixtures)", () => {
  const tokenProvider = { getAccessToken: async () => "token", invalidate: () => {} };

  function catalogWith(handler: (req: RecordedRequest) => Response) {
    const { client, fetch } = makeClient(handler);
    return { catalog: new AliExpressCatalog(client, tokenProvider), fetch };
  }

  const route = (req: RecordedRequest) =>
    req.params.method === "aliexpress.ds.product.get" ? json(PRODUCT) : json(FREIGHT);

  it("fetches a product with the documented parameters", async () => {
    const { catalog, fetch } = catalogWith(route);
    const product = await catalog.getProduct("1005003784285827", "IL");
    expect(product.variants).toHaveLength(2);
    expect(fetch.calls[0]!.params).toMatchObject({
      product_id: "1005003784285827",
      ship_to_country: "IL",
      target_currency: "USD",
    });
  });

  it("accepts the wrapped response envelope", async () => {
    const { catalog } = catalogWith(() =>
      json({ code: "0", aliexpress_ds_product_get_response: { result: PRODUCT.result, rsp_code: "200" } }),
    );
    expect((await catalog.getProduct("1", "IL")).title).toContain("FUQIAN");
  });

  it("maps ITEM_ID_NOT_FOUND to SupplierNotFoundError", async () => {
    const { catalog } = catalogWith(() =>
      json({ code: "0", rsp_code: "ITEM_ID_NOT_FOUND", rsp_msg: "ITEM_ID_NOT_FOUND" }),
    );
    await expect(catalog.getProduct("1", "IL")).rejects.toBeInstanceOf(SupplierNotFoundError);
  });

  it("rejects prices in an unexpected currency", async () => {
    const body = structuredClone(PRODUCT) as {
      result: { ae_item_sku_info_dtos: { currency_code: string }[] };
    };
    body.result.ae_item_sku_info_dtos[0]!.currency_code = "CNY";
    const { catalog } = catalogWith(() => json(body));
    await expect(catalog.getProduct("1", "IL")).rejects.toThrow(/CURRENCY_MISMATCH/);
  });

  it("quotes shipping with the documented queryDeliveryReq JSON", async () => {
    const { catalog, fetch } = catalogWith(route);
    const quotes = await catalog.quoteShipping({
      externalProductId: "1",
      skuId: "sku",
      quantity: 2,
      shipTo: "IL",
    });
    expect(quotes).toHaveLength(2);
    expect(JSON.parse(fetch.calls[0]!.params.queryDeliveryReq!)).toEqual({
      quantity: "2",
      shipToCountry: "IL",
      productId: "1",
      selectedSkuId: "sku",
      language: "en_US",
      currency: "USD",
      locale: "en_US",
    });
  });

  it("treats 'not deliverable' as no options rather than an error", async () => {
    const { catalog } = catalogWith(() =>
      json({ code: "0", result: { success: "false", code: "DELIVERY_NOT_AVAILABLE_TO_YOUR_ADDRESS" } }),
    );
    expect(
      await catalog.quoteShipping({ externalProductId: "1", skuId: "s", quantity: 1, shipTo: "IL" }),
    ).toEqual([]);
  });

  it("finds the lowest landed-cost variant with tracked shipping", async () => {
    const { catalog } = catalogWith(route);
    const best = await catalog.getLowestPriceVariant({ externalProductId: "1", shipTo: "IL", quantity: 1 });
    // Only the first SKU has stock; the tracked option costs $1.99.
    expect(best.variant.skuId).toBe("12000027158136202");
    expect(best.landedCost).toEqual({ amountMinor: 394 + 199, currency: "USD" });
  });

  it("throws NoEligibleVariantError when no SKU has enough stock", async () => {
    const { catalog } = catalogWith(route);
    await expect(
      catalog.getLowestPriceVariant({ externalProductId: "1", shipTo: "IL", quantity: 100 }),
    ).rejects.toBeInstanceOf(NoEligibleVariantError);
  });

  it("reports live stock for one SKU", async () => {
    const { catalog } = catalogWith(route);
    expect(await catalog.checkStock("1", "12000027158136202", 10)).toMatchObject({
      available: 57,
      sufficient: true,
    });
    await expect(catalog.checkStock("1", "missing", 1)).rejects.toBeInstanceOf(SupplierNotFoundError);
  });

  it("retries once with a fresh token after an auth failure", async () => {
    let n = 0;
    let invalidated = 0;
    const { client } = makeClient(() =>
      ++n === 1 ? json({ code: "IllegalAccessToken", message: "expired" }) : json(PRODUCT),
    );
    const catalog = new AliExpressCatalog(client, {
      getAccessToken: async () => `t${n}`,
      invalidate: () => invalidated++,
    });
    await catalog.getProduct("1", "IL");
    expect(invalidated).toBe(1);
  });
});
