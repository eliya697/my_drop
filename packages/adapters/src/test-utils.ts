import type { Clock } from "./http/resilience";

/** A clock whose `sleep` advances virtual time instantly and records every delay. */
export function fakeClock(
  start = 1_700_000_000_000,
): Clock & { sleeps: number[]; advance(ms: number): void } {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    sleeps,
  };
}

export type RecordedRequest = { url: string; params: Record<string, string> };

/** A fetch stub that decodes the form body and answers from `respond`. */
export function fakeFetch(respond: (req: RecordedRequest) => Response | Promise<Response>) {
  const calls: RecordedRequest[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
    const req = { url, params };
    calls.push(req);
    return respond(req);
  }) as typeof fetch;
  return Object.assign(impl, { calls });
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
