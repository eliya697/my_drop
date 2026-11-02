import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorage } from "../storage/storage";
import { fakeFetch } from "../test-utils";
import { fetchImage, ImageRejectedError, processImage, productImageKey } from "./images";

let jpeg: Buffer;
let tiny: Buffer;

beforeAll(async () => {
  jpeg = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#3366ff" } })
    .jpeg()
    .withExif({ IFD0: { Copyright: "secret metadata" } })
    .toBuffer();
  tiny = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#000" } })
    .png()
    .toBuffer();
});

const imageResponse = (body: Uint8Array, type = "image/jpeg") =>
  new Response(body, {
    status: 200,
    headers: { "content-type": type, "content-length": String(body.byteLength) },
  });

describe("fetchImage", () => {
  it("downloads from an allowed CDN over https", async () => {
    const fetch = fakeFetch(() => imageResponse(jpeg));
    const data = await fetchImage("http://ae04.alicdn.com/kf/a.jpg", { fetch });
    expect(Buffer.from(data).equals(jpeg)).toBe(true);
    expect(fetch.calls[0]!.url).toBe("https://ae04.alicdn.com/kf/a.jpg");
  });

  it.each([
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/a.jpg",
    "https://alicdn.com.evil.io/a.jpg",
    "file:///etc/passwd",
    "not a url",
  ])("refuses %s without making a request", async (url) => {
    const fetch = fakeFetch(() => imageResponse(jpeg));
    await expect(fetchImage(url, { fetch })).rejects.toMatchObject({ retryable: false });
    expect(fetch.calls).toHaveLength(0);
  });

  it("rejects non-image content", async () => {
    const fetch = fakeFetch(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
    await expect(fetchImage("https://ae01.alicdn.com/x.jpg", { fetch })).rejects.toThrow(/not an image/);
  });

  it("enforces the size cap while streaming, even without content-length", async () => {
    const fetch = fakeFetch(
      () => new Response(new Uint8Array(2048), { headers: { "content-type": "image/jpeg" } }),
    );
    await expect(fetchImage("https://ae01.alicdn.com/x.jpg", { fetch, maxBytes: 1024 })).rejects.toThrow(
      /too large/,
    );
  });

  it("classifies 5xx as retryable and 404 as permanent", async () => {
    await expect(
      fetchImage("https://ae01.alicdn.com/x.jpg", {
        fetch: fakeFetch(() => new Response("", { status: 503 })),
      }),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      fetchImage("https://ae01.alicdn.com/x.jpg", {
        fetch: fakeFetch(() => new Response("", { status: 404 })),
      }),
    ).rejects.toMatchObject({ retryable: false });
  });
});

describe("processImage", () => {
  it("bounds the size, re-encodes to WebP, and strips metadata", async () => {
    const out = await processImage(jpeg);
    expect(out.contentType).toBe("image/webp");
    expect(out.width).toBe(1600);
    expect(out.height).toBe(800);
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
  });

  it("rejects undecodable data and images that are too small", async () => {
    await expect(processImage(Buffer.from("not an image"))).rejects.toBeInstanceOf(ImageRejectedError);
    await expect(processImage(tiny)).rejects.toThrow(/too small/);
  });
});

describe("productImageKey", () => {
  it("is deterministic and namespaced by product", () => {
    const a = productImageKey("p1", "https://ae01.alicdn.com/a.jpg");
    expect(a).toBe(productImageKey("p1", "https://ae01.alicdn.com/a.jpg"));
    expect(a).toMatch(/^products\/p1\/[0-9a-f]{24}\.webp$/);
    expect(a).not.toBe(productImageKey("p1", "https://ae01.alicdn.com/b.jpg"));
  });
});

describe("LocalStorage", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dropship-storage-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes objects under the root and returns their public URL", async () => {
    const storage = new LocalStorage(dir, "http://localhost:3000/media/");
    const result = await storage.put("products/p1/abc.webp", Buffer.from("x"), "image/webp");
    expect(result.url).toBe("http://localhost:3000/media/products/p1/abc.webp");
    expect(await readFile(join(dir, "products/p1/abc.webp"), "utf8")).toBe("x");
  });

  it.each(["../escape.webp", "products/../../x", "/abs/path", "a//b"])(
    "rejects unsafe key %s",
    async (key) => {
      const storage = new LocalStorage(dir, "http://x");
      await expect(storage.put(key, Buffer.from("x"), "image/webp")).rejects.toThrow(/unsafe|escapes/);
    },
  );
});
