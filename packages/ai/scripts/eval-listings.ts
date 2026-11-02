/**
 * Listing prompt evaluation against the real Claude API. COSTS MONEY — every case is a live call.
 *
 *   pnpm --filter @dropship/ai eval:listings              print the plan and estimated cost
 *   pnpm --filter @dropship/ai eval:listings --yes        run it
 *   pnpm --filter @dropship/ai eval:listings --yes --only medical-claim
 *
 * For each case it checks: the call succeeded, business rules pass, the expected risk flags are
 * present, forbidden phrases are absent from all customer-facing text, and (when set) the
 * expected confidence. Results go to eval/results/<timestamp>.json. Exit code 1 if any case fails.
 * Run it on every prompt change (bump LISTING_PROMPT_VERSION) and compare runs.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import {
  enrichListing,
  LISTING_MODEL,
  LISTING_PROMPT_VERSION,
  type ListingInput,
  type ListingOutput,
} from "../src/index";

type EvalCase = {
  id: string;
  input: ListingInput;
  expectFlags?: string[];
  expectConfidence?: ListingOutput["confidence"];
  forbid?: string[];
};

/** Rough per-case cost for Opus 5.5 at ~2.5k input / ~2k output tokens (incl. thinking). */
const EST_COST_PER_CASE_USD = 0.05;
const out = (s = "") => process.stdout.write(`${s}\n`);

async function main() {
  const { values } = parseArgs({ options: { yes: { type: "boolean" }, only: { type: "string" } } });
  const file = JSON.parse(await readFile(new URL("../eval/cases.json", import.meta.url), "utf8")) as {
    cases: EvalCase[];
  };
  const cases = values.only ? file.cases.filter((c) => c.id === values.only) : file.cases;
  if (cases.length === 0) throw new Error(`no case named ${values.only}`);

  out(`Listing eval — ${cases.length} case(s), model ${LISTING_MODEL}, prompt ${LISTING_PROMPT_VERSION}`);
  out(`Estimated cost: ~$${(cases.length * EST_COST_PER_CASE_USD).toFixed(2)}`);
  if (!values.yes) {
    out("Dry run. Re-run with --yes to call the API.");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

  const client = new Anthropic({ maxRetries: 3 });
  const results = [];
  let totalMicros = 0;

  for (const c of cases) {
    const r = await enrichListing(client, c.input);
    totalMicros += r.meta.costUsdMicros;
    const failures: string[] = [];

    if (!r.ok) {
      failures.push(`${r.status}: ${r.error}`);
    } else {
      const l = r.listing;
      for (const flag of c.expectFlags ?? []) {
        if (!l.risk_flags.includes(flag as never)) failures.push(`missing risk flag ${flag}`);
      }
      if (c.expectConfidence && l.confidence !== c.expectConfidence) {
        failures.push(`confidence ${l.confidence}, expected ${c.expectConfidence}`);
      }
      const customerText = [
        l.title,
        l.seo_title,
        l.meta_description,
        l.description_html,
        ...l.bullets,
        ...l.tags,
      ].join("\n");
      for (const pattern of c.forbid ?? []) {
        if (new RegExp(pattern, "i").test(customerText)) failures.push(`forbidden text /${pattern}/`);
      }
    }

    const passed = failures.length === 0;
    out(
      `${passed ? "PASS" : "FAIL"}  ${c.id.padEnd(34)} $${(r.meta.costUsdMicros / 1e6).toFixed(4)}${passed ? "" : `  — ${failures.join("; ")}`}`,
    );
    results.push({ id: c.id, passed, failures, result: r });
  }

  const passed = results.filter((r) => r.passed).length;
  out();
  out(`${passed}/${results.length} passed · total cost $${(totalMicros / 1e6).toFixed(4)}`);

  await mkdir(new URL("../eval/results/", import.meta.url), { recursive: true });
  const target = new URL(
    `../eval/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    import.meta.url,
  );
  await writeFile(
    target,
    JSON.stringify(
      {
        model: LISTING_MODEL,
        promptVersion: LISTING_PROMPT_VERSION,
        passed,
        total: results.length,
        totalCostUsd: totalMicros / 1e6,
        results,
      },
      null,
      2,
    ),
  );
  out(`Report: ${target.pathname}`);
  if (passed < results.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
