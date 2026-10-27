import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@dropship/logger";
import { runReadiness, type ReadinessCheck } from "./checks";
import { startHealthServer, type HealthServer } from "./server";

const silent = createLogger({
  service: "test",
  level: "silent",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

let server: HealthServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(checks: Record<string, ReadinessCheck>, accepting = true) {
  server = await startHealthServer({
    port: 0,
    host: "127.0.0.1",
    logger: silent,
    checks,
    isAcceptingWork: () => accepting,
  });
  const base = `http://127.0.0.1:${server.port()}`;
  return (path: string) => fetch(`${base}${path}`);
}

const pass: ReadinessCheck = async () => ({ ok: true });
const fail: ReadinessCheck = async () => ({ ok: false, error: "nope" });
const boom: ReadinessCheck = async () => {
  throw new Error("connection refused");
};

describe("runReadiness", () => {
  it("is ok only when every check passes", async () => {
    expect((await runReadiness({ a: pass, b: pass })).ok).toBe(true);
    expect((await runReadiness({ a: pass, b: fail })).ok).toBe(false);
  });

  it("reports a throwing check as failed instead of rejecting", async () => {
    const report = await runReadiness({ db: boom });
    expect(report).toEqual({ ok: false, checks: { db: { ok: false, error: "connection refused" } } });
  });
});

describe("health server", () => {
  it("answers liveness without running dependency checks", async () => {
    const get = await start({ db: boom });
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("returns 200 on /readyz when all checks pass", async () => {
    const get = await start({ db: pass, queue: pass });
    const res = await get("/readyz");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 503 on /readyz when a dependency fails", async () => {
    const get = await start({ db: boom, queue: pass });
    const res = await get("/readyz");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, checks: { db: { ok: false } } });
  });

  it("returns 503 on /readyz while not accepting work", async () => {
    const get = await start({ db: pass }, false);
    expect((await get("/readyz")).status).toBe(503);
  });

  it("returns 404 for unknown paths", async () => {
    const get = await start({});
    expect((await get("/nope")).status).toBe(404);
  });
});
