import {
  SupplierAuthError,
  type SupplierError,
  SupplierNotFoundError,
  SupplierRateLimitError,
  SupplierRejectedError,
  SupplierUnavailableError,
} from "@dropship/core";

export const SUPPLIER = "aliexpress";

/**
 * Gateway error envelope. The platform reports failures with a non-"0" `code`, a `type`
 * (SYSTEM: request rejected by the gateway; ISV: business rule; ISP: backend service failure),
 * `message` and `request_id`. Business APIs may additionally report `rsp_code`/`rsp_msg`.
 */
export type GatewayError = {
  code: string;
  type?: string;
  message?: string;
  requestId?: string;
};

const RATE_LIMIT = /call.?limit|frequency|throttl|too.?many|flow.?control/i;
const AUTH =
  /access.?token|session|token.*(expired|invalid)|unauthori[sz]ed|IllegalAccessToken|InvalidSession/i;
const SIGNATURE = /signature|IncompleteSignature|InvalidSign|InvalidAppKey|AppKey/i;
const NOT_FOUND = /ITEM_ID_NOT_FOUND|DELIVERY_INFO_EMPTY|not.?found/i;
const NOT_DELIVERABLE = /DELIVERY_NOT_AVAILABLE|not allowed to this country/i;

/**
 * Maps a gateway error to the domain's supplier error hierarchy. Classification is by error code
 * and category because the platform does not document a stable, exhaustive code list.
 */
export function classifyGatewayError(
  err: GatewayError,
  context: { resourceId?: string } = {},
): SupplierError {
  const text = `${err.code} ${err.message ?? ""}`;
  const suffix = err.requestId ? ` (request ${err.requestId})` : "";

  if (RATE_LIMIT.test(text)) return new SupplierRateLimitError(SUPPLIER, null);
  if (AUTH.test(text)) return new SupplierAuthError(SUPPLIER, `${err.code}: ${err.message ?? ""}${suffix}`);
  // A bad signature or app key is a configuration error, not a transient one.
  if (SIGNATURE.test(text))
    return new SupplierAuthError(SUPPLIER, `${err.code}: ${err.message ?? ""}${suffix}`);
  if (NOT_FOUND.test(text) && context.resourceId) {
    return new SupplierNotFoundError(SUPPLIER, "product", context.resourceId);
  }
  if (NOT_DELIVERABLE.test(text))
    return new SupplierRejectedError(SUPPLIER, err.code, err.message ?? "not deliverable");
  if (err.type === "ISP" || /system.?error|service.?unavailable|timeout/i.test(text)) {
    return new SupplierUnavailableError(SUPPLIER, `${err.code}: ${err.message ?? ""}${suffix}`);
  }
  return new SupplierRejectedError(SUPPLIER, err.code, `${err.message ?? "request rejected"}${suffix}`);
}
