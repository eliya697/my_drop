import { pingDatabase } from "@dropship/db";
import { getDb } from "@/lib/server/db";
import { logger } from "@/lib/server/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Readiness: the database answers. Used by uptime monitoring. */
export async function GET() {
  const started = performance.now();
  try {
    await pingDatabase(getDb().sql);
    return Response.json(
      { ok: true, checks: { database: { ok: true, latencyMs: Math.round(performance.now() - started) } } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    logger.warn({ err }, "readiness check failed");
    return Response.json(
      { ok: false, checks: { database: { ok: false } } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
