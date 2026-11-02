import type Anthropic from "@anthropic-ai/sdk";
import type { ListingOutput } from "./listing/schema";

/** A listing that satisfies every business rule — the baseline for tests and fakes. */
export function validListing(overrides: Partial<ListingOutput> = {}): ListingOutput {
  return {
    title: "מנורת שולחן LED מתכווננת עם 3 גווני תאורה",
    seo_title: "מנורת שולחן LED מתכווננת לעבודה ולימודים",
    meta_description:
      "מנורת שולחן LED עם זרוע גמישה, 3 גווני אור ו-5 רמות עוצמה. אור נעים לעיניים לעבודה וללימודים. הזמינו עכשיו עם משלוח עד הבית.",
    slug: "adjustable-led-desk-lamp",
    bullets: [
      "זרוע גמישה שמכוונת את האור בדיוק לאן שצריך",
      "3 גווני תאורה: חם, ניטרלי וקר",
      "5 רמות עוצמה בלחיצה אחת",
    ],
    description_html:
      "<h2>אור נכון לכל משימה</h2><p>מנורת שולחן LED עם זרוע גמישה ושלושה גווני תאורה, שמתאימה לעבודה מול מחשב, לקריאה וללימודים.</p><ul><li>הפעלה במגע</li><li>טעינה ב-USB</li></ul>",
    category: "תאורה לבית",
    tags: ["מנורת שולחן", "מנורת לד", "תאורה לחדר עבודה"],
    target_audience: "סטודנטים ועובדים מהבית שצריכים אור נוח לאורך שעות.",
    positioning: "standard",
    ad_angles: [{ hook: "העיניים עייפות אחרי יום מול המסך?", angle: "problem_solution" }],
    risk_flags: [],
    confidence: "high",
    ...overrides,
  };
}

export type FakeParseCall = Record<string, unknown>;

/**
 * Minimal stand-in for the Anthropic client covering what the listing code uses:
 * `beta.messages.parse` and `messages.batches.{create,retrieve,results}`.
 */
export function fakeAnthropic(handlers: {
  parse?: (params: FakeParseCall) => unknown | Promise<unknown>;
  batches?: {
    create?: (params: { requests: { custom_id: string }[] }) => unknown;
    retrieve?: (id: string) => unknown;
    results?: (id: string) => unknown[];
  };
}) {
  const calls: { parse: FakeParseCall[]; batchCreate: unknown[] } = { parse: [], batchCreate: [] };
  const client = {
    beta: {
      messages: {
        parse: async (params: FakeParseCall) => {
          calls.parse.push(params);
          if (!handlers.parse) throw new Error("unexpected parse call");
          return handlers.parse(params);
        },
      },
    },
    messages: {
      batches: {
        create: async (params: { requests: { custom_id: string }[] }) => {
          calls.batchCreate.push(params);
          return (
            handlers.batches?.create?.(params) ?? { id: "msgbatch_test", processing_status: "in_progress" }
          );
        },
        retrieve: async (id: string) =>
          handlers.batches?.retrieve?.(id) ?? { id, processing_status: "in_progress" },
        results: async (id: string) => {
          const items = handlers.batches?.results?.(id) ?? [];
          return (async function* () {
            yield* items;
          })();
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

/** A successful parsed response, shaped like `client.beta.messages.parse`'s result. */
export function parsedResponse(listing: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    stop_details: null,
    content: [{ type: "text", text: JSON.stringify(listing) }],
    usage: {
      input_tokens: 2_000,
      output_tokens: 1_500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: null,
    },
    parsed_output: listing,
    ...overrides,
  };
}
