import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { costUsdMicros, type TokenUsage } from "../cost";
import { sanitizeDescriptionHtml } from "../html";
import { buildListingUserMessage, LISTING_PROMPT_VERSION, LISTING_SYSTEM, type ListingInput } from "./prompt";
import { checkListingRules, ListingOutput, type RuleViolation } from "./schema";

export const LISTING_MODEL = "claude-opus-5-5";
/** Listing copy is a moderately hard writing task; "medium" is Opus 5.5's default, set explicitly. */
export const LISTING_EFFORT = "medium" as const;
const MAX_TOKENS = 16_000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type GenerationStatus = "ok" | "refusal" | "parse_error" | "api_error" | "rejected_by_validator";

export type GenerationMeta = {
  model: string;
  promptVersion: string;
  usage: TokenUsage | null;
  costUsdMicros: number;
  latencyMs: number;
  stopReason: string | null;
  /** True when the server re-ran the request on another model after a policy decline. */
  fallbackUsed: boolean;
  batch: boolean;
};

export type EnrichResult =
  | { ok: true; listing: ListingOutput; meta: GenerationMeta }
  | {
      ok: false;
      status: Exclude<GenerationStatus, "ok">;
      error: string;
      violations?: RuleViolation[];
      /** The raw model output, kept for debugging rejected listings. */
      output?: unknown;
      meta: GenerationMeta;
    };

export type EnrichOptions = { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" };

function baseParams(input: ListingInput, opts: EnrichOptions) {
  return {
    model: opts.model ?? LISTING_MODEL,
    max_tokens: MAX_TOKENS,
    system: LISTING_SYSTEM,
    messages: [{ role: "user" as const, content: buildListingUserMessage(input) }],
  };
}

/**
 * Generates a listing in real time. Uses structured outputs (schema-valid JSON or nothing),
 * the server-side refusal fallback, and then the business-rule validator. Transient API errors
 * (429/5xx/network) are thrown for the job queue to retry; everything else is returned as a
 * typed failure so the caller can record it.
 */
export async function enrichListing(
  client: Anthropic,
  input: ListingInput,
  opts: EnrichOptions = {},
): Promise<EnrichResult> {
  const started = performance.now();
  const params = baseParams(input, opts);
  try {
    const response = await client.beta.messages.parse({
      ...params,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: opts.effort ?? LISTING_EFFORT, format: betaZodOutputFormat(ListingOutput) },
    });
    const fallbackUsed = (response.usage.iterations ?? []).some((i) => i.type === "fallback_message");
    return interpretListing(
      {
        model: response.model,
        stop_reason: response.stop_reason,
        stop_details: response.stop_details,
        usage: response.usage,
        parsed: response.parsed_output,
        text: textOf(response.content),
      },
      { latencyMs: performance.now() - started, fallbackUsed, batch: false },
    );
  } catch (err) {
    if (isRetryableAnthropicError(err)) throw err;
    return {
      ok: false,
      status: "api_error",
      error: err instanceof Error ? err.message : String(err),
      meta: emptyMeta(params.model, performance.now() - started, false),
    };
  }
}

/** One Batches API request for a listing (50% price, no server-side fallback). */
export function listingBatchRequest(customId: string, input: ListingInput, opts: EnrichOptions = {}) {
  return {
    custom_id: customId,
    params: {
      ...baseParams(input, opts),
      output_config: { effort: opts.effort ?? LISTING_EFFORT, format: zodOutputFormat(ListingOutput) },
    },
  } satisfies Anthropic.Messages.BatchCreateParams.Request;
}

/** Turns one Batches API result into the same `EnrichResult` the real-time path returns. */
export function interpretBatchResult(
  result: Anthropic.Messages.MessageBatchResult,
  model = LISTING_MODEL,
): EnrichResult {
  switch (result.type) {
    case "succeeded": {
      const m = result.message;
      return interpretListing(
        {
          model: m.model,
          stop_reason: m.stop_reason,
          stop_details: m.stop_details,
          usage: m.usage,
          parsed: null,
          text: textOf(m.content),
        },
        { latencyMs: 0, fallbackUsed: false, batch: true },
      );
    }
    case "errored":
      return {
        ok: false,
        status: "api_error",
        error: `${result.error.error.type}: ${result.error.error.message}`,
        meta: emptyMeta(model, 0, true),
      };
    case "canceled":
    case "expired":
      return {
        ok: false,
        status: "api_error",
        error: `batch request ${result.type}`,
        meta: emptyMeta(model, 0, true),
      };
  }
}

type RawResponse = {
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage: TokenUsage;
  parsed: unknown;
  text: string;
};

export function interpretListing(
  raw: RawResponse,
  ctx: { latencyMs: number; fallbackUsed: boolean; batch: boolean },
): EnrichResult {
  const meta: GenerationMeta = {
    model: raw.model,
    promptVersion: LISTING_PROMPT_VERSION,
    usage: raw.usage,
    costUsdMicros: costUsdMicros(raw.model, raw.usage, { batch: ctx.batch }),
    latencyMs: Math.round(ctx.latencyMs),
    stopReason: raw.stop_reason,
    fallbackUsed: ctx.fallbackUsed,
    batch: ctx.batch,
  };

  if (raw.stop_reason === "refusal") {
    const reason = raw.stop_details?.category ?? "unspecified";
    return { ok: false, status: "refusal", error: `declined (${reason})`, meta };
  }
  if (raw.stop_reason === "max_tokens") {
    return { ok: false, status: "parse_error", error: "output truncated at max_tokens", meta };
  }

  let candidate = raw.parsed;
  if (candidate === null || candidate === undefined) {
    try {
      candidate = JSON.parse(raw.text);
    } catch {
      return {
        ok: false,
        status: "parse_error",
        error: "response is not valid JSON",
        output: raw.text.slice(0, 2000),
        meta,
      };
    }
  }
  const parsed = ListingOutput.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      status: "parse_error",
      error: parsed.error.message.slice(0, 1000),
      output: candidate,
      meta,
    };
  }

  const listing = normalizeListing(parsed.data);
  const violations = checkListingRules(listing);
  if (violations.length > 0) {
    return {
      ok: false,
      status: "rejected_by_validator",
      error: violations.map((v) => `${v.field}: ${v.message}`).join("; "),
      violations,
      output: listing,
      meta,
    };
  }
  return { ok: true, listing, meta };
}

/** Cleanup that never changes meaning: trims, de-duplicates, sanitizes HTML, normalizes the slug. */
export function normalizeListing(l: ListingOutput): ListingOutput {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const unique = (xs: string[]) => [...new Set(xs.map(clean).filter(Boolean))];
  return {
    ...l,
    title: clean(l.title),
    seo_title: clean(l.seo_title),
    meta_description: clean(l.meta_description),
    slug: l.slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, ""),
    bullets: unique(l.bullets),
    tags: unique(l.tags),
    category: clean(l.category),
    description_html: sanitizeDescriptionHtml(l.description_html),
    risk_flags: [...new Set(l.risk_flags)],
  };
}

/** 408/409/429/5xx (incl. 529 overloaded) and connection errors are worth retrying later. */
export function isRetryableAnthropicError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return false;
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function emptyMeta(model: string, latencyMs: number, batch: boolean): GenerationMeta {
  return {
    model,
    promptVersion: LISTING_PROMPT_VERSION,
    usage: null,
    costUsdMicros: 0,
    latencyMs: Math.round(latencyMs),
    stopReason: null,
    fallbackUsed: false,
    batch,
  };
}
