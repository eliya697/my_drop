export const dynamic = "force-dynamic";

/** Liveness: the server process is up. Never checks dependencies. */
export function GET() {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
