import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, REDACTED } from "./index";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(String(chunk)));
      cb();
    },
  });
  const logger = createLogger({ service: "test", level: "debug", destination });
  return { logger, lines };
}

describe("createLogger", () => {
  it("adds service metadata and an ISO timestamp", () => {
    const { logger, lines } = capture();
    logger.info("hello");
    expect(lines[0]).toMatchObject({ service: "test", env: "development", level: "info", msg: "hello" });
    expect(typeof lines[0]?.time).toBe("string");
  });

  it("redacts PII at the top level and in nested objects", () => {
    const { logger, lines } = capture();
    logger.info(
      {
        email: "a@b.com",
        order: {
          id: "o1",
          email: "c@d.com",
          shippingAddress: { line1: "Herzl 1", city: "Tel Aviv" },
          customer: { phone: "+972500000000", profile: { full_name: "Dana" } },
        },
      },
      "order paid",
    );
    const line = lines[0] as {
      email: string;
      order: {
        id: string;
        email: string;
        shippingAddress: string;
        customer: { phone: string; profile: { full_name: string } };
      };
    };
    expect(line.email).toBe(REDACTED);
    expect(line.order.id).toBe("o1");
    expect(line.order.email).toBe(REDACTED);
    expect(line.order.shippingAddress).toBe(REDACTED);
    expect(line.order.customer.phone).toBe(REDACTED);
    expect(line.order.customer.profile.full_name).toBe(REDACTED);
  });

  it("redacts credential headers including hyphenated names", () => {
    const { logger, lines } = capture();
    logger.info({
      req: { headers: { authorization: "Bearer x", "stripe-signature": "t=1,v1=abc", host: "h" } },
    });
    const headers = (lines[0] as { req: { headers: Record<string, string> } }).req.headers;
    expect(headers.authorization).toBe(REDACTED);
    expect(headers["stripe-signature"]).toBe(REDACTED);
    expect(headers.host).toBe("h");
  });

  it("serializes errors with stack traces", () => {
    const { logger, lines } = capture();
    logger.error({ err: new Error("boom") }, "failed");
    expect(lines[0]).toMatchObject({ err: { type: "Error", message: "boom" } });
  });
});
