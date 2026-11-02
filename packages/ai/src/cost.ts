/**
 * Per-million-token prices (USD), Claude API first-party rates as of 2026-10.
 * Batches are billed at 50%. Cache writes cost 1.25× input; cache reads are listed per model.
 * Keep in sync with https://www.anthropic.com/pricing — used for budgeting, not invoicing.
 */
type Rates = { input: number; output: number; cacheRead: number };

const RATES: Record<string, Rates> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/** Unknown models are priced at the most expensive known rate, so budgets err on the safe side. */
const FALLBACK_RATES: Rates = { input: 10, output: 50, cacheRead: 0.5 };

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/** Cost in micro-dollars (1e-6 USD), rounded up. */
export function costUsdMicros(model: string, usage: TokenUsage, opts: { batch?: boolean } = {}): number {
  const rates = RATES[model] ?? FALLBACK_RATES;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const dollars =
    (usage.input_tokens * rates.input +
      cacheWrite * rates.input * 1.25 +
      cacheRead * rates.cacheRead +
      usage.output_tokens * rates.output) /
    1_000_000;
  return Math.ceil(dollars * (opts.batch ? 0.5 : 1) * 1_000_000);
}
