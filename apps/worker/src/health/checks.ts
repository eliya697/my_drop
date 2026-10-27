import type { Sql } from "postgres";
import { pingDatabase } from "@dropship/db";

export type CheckResult = { ok: boolean; detail?: Record<string, unknown>; error?: string };
export type ReadinessReport = { ok: boolean; checks: Record<string, CheckResult> };
export type ReadinessCheck = () => Promise<CheckResult>;

export function databaseCheck(sql: Sql): ReadinessCheck {
  return async () => {
    const started = performance.now();
    await pingDatabase(sql);
    return { ok: true, detail: { latencyMs: Math.round(performance.now() - started) } };
  };
}

export type QueueHealthOptions = {
  sql: Sql;
  schema: string;
  heartbeatQueue: string;
  heartbeatStaleSeconds: number;
  stuckJobMinutes: number;
};

/**
 * Queue health from pg-boss's own tables:
 *  - the latest completed heartbeat must be recent (scheduler + workers alive), and
 *  - no job may be stuck in `active` beyond the threshold (hung handler or dead worker).
 * Failed-job counts are reported for dashboards but do not fail readiness: failures are handled
 * by retries and the dead-letter queue, and restarting the process would not fix them.
 */
export function queueCheck(opts: QueueHealthOptions): ReadinessCheck {
  const jobTable = opts.sql(`${opts.schema}.job`);
  const archiveTable = opts.sql(`${opts.schema}.archive`);

  return async () => {
    const [stats] = await opts.sql<
      { last_heartbeat_age_s: number | null; stuck_active: number; failed_last_hour: number }[]
    >`
      select
        (select extract(epoch from now() - max(completed_on))::int
           from (
             select completed_on from ${jobTable}
               where name = ${opts.heartbeatQueue} and state = 'completed'
             union all
             select completed_on from ${archiveTable}
               where name = ${opts.heartbeatQueue} and state = 'completed'
           ) hb) as last_heartbeat_age_s,
        (select count(*)::int from ${jobTable}
           where state = 'active' and started_on < now() - make_interval(mins => ${opts.stuckJobMinutes})) as stuck_active,
        (select count(*)::int from ${jobTable}
           where state = 'failed' and completed_on > now() - interval '1 hour') as failed_last_hour`;

    const age = stats?.last_heartbeat_age_s ?? null;
    const stuck = stats?.stuck_active ?? 0;
    const heartbeatOk = age !== null && age <= opts.heartbeatStaleSeconds;
    const detail = {
      lastHeartbeatAgeSeconds: age,
      stuckActiveJobs: stuck,
      failedLastHour: stats?.failed_last_hour ?? 0,
    };

    if (!heartbeatOk) {
      return {
        ok: false,
        detail,
        error: age === null ? "no heartbeat has completed yet" : `last heartbeat ${age}s ago`,
      };
    }
    if (stuck > 0)
      return { ok: false, detail, error: `${stuck} job(s) active longer than ${opts.stuckJobMinutes}m` };
    return { ok: true, detail };
  };
}

/** Runs all checks in parallel; a check that throws is reported as failed, never as a crash. */
export async function runReadiness(checks: Record<string, ReadinessCheck>): Promise<ReadinessReport> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, CheckResult]> => {
      try {
        return [name, await check()];
      } catch (err) {
        return [name, { ok: false, error: err instanceof Error ? err.message : String(err) }];
      }
    }),
  );
  const results = Object.fromEntries(entries);
  return { ok: entries.every(([, r]) => r.ok), checks: results };
}
