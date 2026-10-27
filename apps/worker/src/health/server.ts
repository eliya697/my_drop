import { createServer, type Server } from "node:http";
import type { Logger } from "@dropship/logger";
import { runReadiness, type ReadinessCheck } from "./checks";

export type HealthServerOptions = {
  port: number;
  host?: string;
  logger: Logger;
  checks: Record<string, ReadinessCheck>;
  /** Readiness is reported as failed while starting up and while draining on shutdown. */
  isAcceptingWork: () => boolean;
};

export type HealthServer = { server: Server; close: () => Promise<void>; port: () => number };

/**
 *   GET /healthz  liveness  — 200 while the event loop is responsive. Never touches dependencies,
 *                             so a database outage does not make the orchestrator kill the worker.
 *   GET /readyz   readiness — 200 only when the database answers and the queue is healthy.
 */
export function startHealthServer(opts: HealthServerOptions): Promise<HealthServer> {
  const startedAt = Date.now();

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };

    if (req.method !== "GET" && req.method !== "HEAD") return send(405, { error: "method not allowed" });
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/healthz") {
      return send(200, { ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
    }

    if (path === "/readyz") {
      if (!opts.isAcceptingWork()) return send(503, { ok: false, error: "not accepting work" });
      const report = await runReadiness(opts.checks);
      if (!report.ok) opts.logger.warn({ checks: report.checks }, "readiness check failed");
      return send(report.ok ? 200 : 503, report);
    }

    return send(404, { error: "not found" });
  });

  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 10_000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : opts.port;
      opts.logger.info({ port: boundPort }, "health server listening");
      resolve({
        server,
        port: () => boundPort,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
