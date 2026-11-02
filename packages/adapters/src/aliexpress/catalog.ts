import {
  selectLowestPriceVariant,
  SupplierAuthError,
  SupplierNotFoundError,
  SupplierRejectedError,
  type CountryCode,
  type LowestPriceVariant,
  type LowestPriceVariantQuery,
  type ShippingQuote,
  type ShippingQuoteQuery,
  type StockCheck,
  type SupplierCatalog,
  type SupplierProduct,
} from "@dropship/core";
import { ConcurrencyLimiter } from "../http/resilience";
import type { AliExpressClient, JsonObject } from "./client";
import { classifyGatewayError, SUPPLIER } from "./errors";
import { normalizeFreight, normalizeProduct } from "./normalize";
import { MalformedPayloadError, str, unwrapResponse } from "./parse";

export type AccessTokenProvider = { getAccessToken(): Promise<string>; invalidate?(): void };

export type AliExpressCatalogOptions = {
  /** Currency for prices and shipping fees. Must match the pricing engine's supplier currency. */
  currency?: string;
  language?: string;
  /** Parallel freight queries when quoting every SKU of a product. */
  quoteConcurrency?: number;
  /** Destination used by `checkStock`, whose signature carries no country. */
  defaultShipTo?: CountryCode;
  now?: () => Date;
};

const PRODUCT_GET = "aliexpress.ds.product.get";
const FREIGHT_QUERY = "aliexpress.ds.freight.query";

/** SupplierCatalog backed by the AliExpress Dropshipping APIs. */
export class AliExpressCatalog implements SupplierCatalog {
  readonly name = SUPPLIER;
  private readonly currency: string;
  private readonly language: string;
  private readonly quoteLimiter: ConcurrencyLimiter;
  private readonly now: () => Date;
  private readonly defaultShipTo: CountryCode;

  constructor(
    private readonly client: AliExpressClient,
    private readonly tokens: AccessTokenProvider,
    opts: AliExpressCatalogOptions = {},
  ) {
    this.currency = opts.currency ?? "USD";
    this.language = opts.language ?? "en";
    this.quoteLimiter = new ConcurrencyLimiter(opts.quoteConcurrency ?? 3);
    this.now = opts.now ?? (() => new Date());
    this.defaultShipTo = opts.defaultShipTo ?? "IL";
  }

  async getProduct(externalProductId: string, shipTo: CountryCode): Promise<SupplierProduct> {
    const body = await this.call(PRODUCT_GET, externalProductId, {
      product_id: externalProductId,
      ship_to_country: shipTo,
      target_currency: this.currency,
      target_language: this.language,
      remove_personal_benefit: "true",
    });
    const envelope = unwrapResponse(body, PRODUCT_GET);
    this.assertBusinessSuccess(envelope, externalProductId);
    const result = envelope.result;
    if (!result || typeof result !== "object")
      throw new SupplierNotFoundError(SUPPLIER, "product", externalProductId);

    const product = this.wrapMalformed(() => normalizeProduct(result as JsonObject, externalProductId, body));
    for (const v of product.variants) {
      if (v.unitCost.currency !== this.currency) {
        throw new SupplierRejectedError(
          SUPPLIER,
          "CURRENCY_MISMATCH",
          `sku ${v.skuId} priced in ${v.unitCost.currency}, expected ${this.currency}`,
        );
      }
    }
    return product;
  }

  async quoteShipping(query: ShippingQuoteQuery): Promise<ShippingQuote[]> {
    const body = await this.call(FREIGHT_QUERY, query.externalProductId, {
      queryDeliveryReq: JSON.stringify({
        quantity: String(query.quantity),
        shipToCountry: query.shipTo,
        productId: query.externalProductId,
        selectedSkuId: query.skuId,
        language: this.language === "en" ? "en_US" : this.language,
        currency: this.currency,
        locale: "en_US",
      }),
    });
    const result = unwrapResponse(body, FREIGHT_QUERY).result as JsonObject | undefined;
    if (!result) return [];
    if (result.success !== undefined && String(result.success) !== "true") {
      const code = str(result.code) ?? "FREIGHT_FAILED";
      // Not deliverable / no options is an answer, not an error.
      if (/DELIVERY_NOT_AVAILABLE|DELIVERY_INFO_EMPTY/i.test(`${code} ${str(result.msg) ?? ""}`)) return [];
      throw classifyGatewayError({ code, message: str(result.msg) }, { resourceId: query.externalProductId });
    }
    return this.wrapMalformed(() => normalizeFreight(result, query.skuId)).filter(
      (q) => q.cost.currency === this.currency,
    );
  }

  async getLowestPriceVariant(query: LowestPriceVariantQuery): Promise<LowestPriceVariant> {
    const product = await this.getProduct(query.externalProductId, query.shipTo);
    if (!product.available)
      throw new SupplierRejectedError(SUPPLIER, "PRODUCT_UNAVAILABLE", "product is not on sale");
    const allowed = query.skuIds ? new Set(query.skuIds) : null;
    const candidates = product.variants.filter(
      (v) => v.stock >= query.quantity && (!allowed || allowed.has(v.skuId)),
    );
    const quotes = (
      await Promise.all(
        candidates.map((v) =>
          this.quoteLimiter.run(() =>
            this.quoteShipping({
              externalProductId: query.externalProductId,
              skuId: v.skuId,
              quantity: query.quantity,
              shipTo: query.shipTo,
            }),
          ),
        ),
      )
    ).flat();
    return selectLowestPriceVariant(SUPPLIER, candidates, quotes, query);
  }

  async checkStock(externalProductId: string, skuId: string, quantity: number): Promise<StockCheck> {
    // ds.product.get is the only documented source of live per-SKU stock.
    const product = await this.getProduct(externalProductId, this.defaultShipTo);
    const variant = product.variants.find((v) => v.skuId === skuId);
    if (!variant) throw new SupplierNotFoundError(SUPPLIER, "sku", skuId);
    const available = product.available ? variant.stock : 0;
    return {
      skuId,
      available,
      sufficient: available >= quantity,
      unitCost: variant.unitCost,
      checkedAt: this.now(),
    };
  }

  /** One call with token handling: on an auth failure, drop the cached token and retry once. */
  private async call(
    method: string,
    resourceId: string,
    params: Record<string, string>,
  ): Promise<JsonObject> {
    const attempt = async () =>
      this.client.business<JsonObject>(method, params, {
        accessToken: await this.tokens.getAccessToken(),
        resourceId,
      });
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof SupplierAuthError && this.tokens.invalidate) {
        this.tokens.invalidate();
        return attempt();
      }
      throw err;
    }
  }

  /** `rsp_code` other than 200 inside a successful gateway response is a business failure. */
  private assertBusinessSuccess(envelope: JsonObject, productId: string) {
    const rspCode = str(envelope.rsp_code);
    if (rspCode === undefined || rspCode === "200") return;
    const message = str(envelope.rsp_msg) ?? "";
    if (/ITEM_ID_NOT_FOUND|not.?found/i.test(`${rspCode} ${message}`)) {
      throw new SupplierNotFoundError(SUPPLIER, "product", productId);
    }
    throw classifyGatewayError({ code: rspCode, message }, { resourceId: productId });
  }

  private wrapMalformed<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof MalformedPayloadError) {
        throw new SupplierRejectedError(SUPPLIER, "MALFORMED_PAYLOAD", err.message);
      }
      throw err;
    }
  }
}
