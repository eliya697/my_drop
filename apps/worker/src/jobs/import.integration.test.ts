import { mkdtemp, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { LocalStorage } from "@dropship/adapters";
import type { ShippingQuote, SupplierProduct } from "@dropship/core";
import { InMemorySupplierAdapter } from "@dropship/core/testing";
import { createDb, productImages, products, productVariants, type DbHandle } from "@dropship/db";
import { runMigrations } from "@dropship/db/migrate";
import { createLogger } from "@dropship/logger";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Enqueue } from "../queue/run";
import { isPermanent } from "../queue/run";
import { createImportFetchHandler, IMPORT_MEDIA_QUEUE } from "./import-fetch";
import { createImportMediaHandler, TransientMediaError } from "./import-media";

const url = process.env.TEST_DATABASE_URL;

const logger = createLogger({
  service: "test",
  level: "silent",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });

function recordingEnqueue() {
  const sent: { queue: string; data: unknown; options: unknown }[] = [];
  const enqueue: Enqueue = async (queue, data, options) => {
    sent.push({ queue, data, options });
    return randomUUID();
  };
  return { enqueue, sent };
}

function supplierProduct(externalId: string): SupplierProduct {
  return {
    supplier: "in-memory",
    externalId,
    title: "Desk Lamp",
    descriptionRaw: "<p>lamp</p>",
    images: ["https://ae01.alicdn.com/kf/lamp-1.jpg", "https://ae01.alicdn.com/kf/lamp-2.jpg"],
    attributes: {},
    variants: [
      { skuId: "white", options: { Color: "White" }, unitCost: usd(1200), stock: 30 },
      { skuId: "black", options: { Color: "Black" }, unitCost: usd(1250), stock: 10 },
      { skuId: "red", options: { Color: "Red" }, unitCost: usd(1100), stock: 0 },
      { skuId: "gold", options: { Color: "Gold" }, unitCost: usd(1500), stock: 5 },
    ],
    sellerId: "seller-9",
    available: true,
    raw: { id: externalId },
  };
}

const q = (skuId: string, method: string, cents: number, daysMax: number, tracked = true): ShippingQuote => ({
  skuId,
  method,
  cost: usd(cents),
  daysMin: Math.max(1, daysMax - 10),
  daysMax,
  tracked,
});

const QUOTES = [
  q("white", "STANDARD", 300, 25),
  q("white", "ECONOMY", 0, 50, false),
  q("white", "EXPRESS", 1500, 8),
  q("black", "STANDARD", 350, 25),
  // gold only ships untracked or too slowly → imported inactive
  q("gold", "ECONOMY", 0, 45, false),
  q("gold", "SLOW", 100, 60),
];

describe.skipIf(!url)("import jobs (integration)", () => {
  let handle: DbHandle;
  let storageDir: string;

  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!, { max: 4 });
    storageDir = await mkdtemp(join(tmpdir(), "dropship-media-"));
  });

  afterAll(async () => {
    await handle?.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  async function importOne() {
    const externalId = String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
    const catalog = new InMemorySupplierAdapter().addProduct(supplierProduct(externalId), QUOTES);
    const { enqueue, sent } = recordingEnqueue();
    const handler = createImportFetchHandler({ db: handle.db, catalog, shipTo: "IL", maxShippingDays: 30 });
    const result = await handler({ externalProductId: externalId }, { enqueue, logger });
    return { externalId, result, sent, catalog, handler, enqueue };
  }

  it("import.fetch picks the cheapest tracked option within the delivery limit per SKU", async () => {
    const { result, sent } = await importOne();
    expect(result).toMatchObject({ created: true, activeVariants: 2, pendingImages: 2 });

    const variants = await handle.db
      .select()
      .from(productVariants)
      .where(eq(productVariants.productId, result.productId))
      .orderBy(productVariants.externalSkuId);
    const bySku = Object.fromEntries(variants.map((v) => [v.externalSkuId, v]));
    // white: ECONOMY is cheaper but untracked; EXPRESS is tracked but pricier → STANDARD
    expect(bySku.white).toMatchObject({ isActive: true, shippingMethod: "STANDARD", shippingCostMinor: 300 });
    expect(bySku.black).toMatchObject({ isActive: true, shippingMethod: "STANDARD", shippingCostMinor: 350 });
    expect(bySku.red).toMatchObject({ isActive: false, shippingMethod: null }); // no stock, not quoted
    expect(bySku.gold).toMatchObject({ isActive: false, shippingMethod: null }); // nothing tracked within 30 days

    expect(sent).toEqual([
      {
        queue: IMPORT_MEDIA_QUEUE,
        data: { productId: result.productId },
        options: undefined,
      },
    ]);
  });

  it("import.fetch rejects a product that is not on sale, permanently", async () => {
    const externalId = "9999999999990001";
    const catalog = new InMemorySupplierAdapter().addProduct(
      { ...supplierProduct(externalId), available: false },
      QUOTES,
    );
    const handler = createImportFetchHandler({ db: handle.db, catalog, shipTo: "IL", maxShippingDays: 30 });
    const err = await handler({ externalProductId: externalId }, { ...recordingEnqueue(), logger }).catch(
      (e: unknown) => e,
    );
    expect(isPermanent(err)).toBe(true);
    const rows = await handle.db.select().from(products).where(eq(products.externalId, externalId));
    expect(rows).toHaveLength(0);
  });

  it("import.fetch treats an unknown product as permanent", async () => {
    const handler = createImportFetchHandler({
      db: handle.db,
      catalog: new InMemorySupplierAdapter(),
      shipTo: "IL",
      maxShippingDays: 30,
    });
    const err = await handler({ externalProductId: "1234567890" }, { ...recordingEnqueue(), logger }).catch(
      (e: unknown) => e,
    );
    expect(isPermanent(err)).toBe(true);
  });

  it("import.media stores processed images and marks bad ones without retrying them", async () => {
    const { result } = await importOne();
    const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#ffaa00" } })
      .jpeg()
      .toBuffer();
    const fetch = (async (input: string | URL | Request) =>
      String(input).endsWith("lamp-1.jpg")
        ? new Response(jpeg, { headers: { "content-type": "image/jpeg" } })
        : new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof globalThis.fetch;

    const handler = createImportMediaHandler({
      db: handle.db,
      storage: new LocalStorage(storageDir, "http://localhost:3000/media"),
      fetchOptions: { fetch },
    });
    expect(await handler({ productId: result.productId }, { logger })).toEqual({
      stored: 1,
      rejected: 1,
      retryable: 0,
    });

    const images = await handle.db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, result.productId))
      .orderBy(productImages.position);
    expect(images[0]).toMatchObject({ width: 1200, height: 900, failedReason: null });
    expect(images[0]!.storageKey).toMatch(new RegExp(`^products/${result.productId}/[0-9a-f]{24}\\.webp$`));
    expect(images[1]).toMatchObject({
      storageKey: null,
      failedReason: expect.stringMatching(/not an image/),
    });
    expect(await readdir(join(storageDir, "products", result.productId))).toHaveLength(1);

    // A second run has nothing left to do.
    expect(await handler({ productId: result.productId }, { logger })).toEqual({
      stored: 0,
      rejected: 0,
      retryable: 0,
    });
  });

  it("import.media retries transient failures and only reprocesses what is still pending", async () => {
    const { result } = await importOne();
    const jpeg = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#00aa55" } })
      .jpeg()
      .toBuffer();
    let outage = true;
    const fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("lamp-2.jpg") && outage) return new Response("", { status: 503 });
      return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
    }) as typeof globalThis.fetch;
    const handler = createImportMediaHandler({
      db: handle.db,
      storage: new LocalStorage(storageDir, "http://localhost:3000/media"),
      fetchOptions: { fetch },
    });

    const err = await handler({ productId: result.productId }, { logger }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientMediaError);
    expect(isPermanent(err)).toBe(false);

    outage = false;
    expect(await handler({ productId: result.productId }, { logger })).toEqual({
      stored: 1,
      rejected: 0,
      retryable: 0,
    });
  });
});
