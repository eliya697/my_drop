import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";

/**
 * Runs against a real Postgres (docker compose locally, a service container in CI).
 * Set TEST_DATABASE_URL to enable; the suite is skipped otherwise so unit runs stay offline.
 */
const url = process.env.TEST_DATABASE_URL;

const EXPECTED_TABLES = [
  "profiles",
  "addresses",
  "supplier_products",
  "products",
  "product_variants",
  "product_images",
  "pricing_rules",
  "ai_generations",
  "carts",
  "cart_items",
  "orders",
  "order_items",
  "supplier_orders",
  "shipments",
  "support_tickets",
  "support_messages",
  "webhook_events",
  "audit_log",
  "integration_credentials",
  "ad_campaigns",
];

describe.skipIf(!url)("database schema (integration)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await runMigrations(url!);
    // Applying twice must be a no-op.
    await runMigrations(url!);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("creates every table with row level security enabled", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`;
    const byName = new Map(rows.map((r) => [r.relname, r.relrowsecurity]));
    for (const table of EXPECTED_TABLES) {
      expect(byName.has(table), `missing table ${table}`).toBe(true);
      expect(byName.get(table), `RLS disabled on ${table}`).toBe(true);
    }
  });

  it("creates all enums", async () => {
    const rows = await sql<{ typname: string }[]>`
      select typname from pg_type where typtype = 'e' and typnamespace = 'public'::regnamespace`;
    expect(rows.map((r) => r.typname).sort()).toEqual(
      [
        "ai_task",
        "cart_status",
        "order_status",
        "product_status",
        "supplier_order_status",
        "user_role",
      ].sort(),
    );
  });

  it("creates the GIN full-text index on products", async () => {
    const [row] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'public' and indexname = 'products_fts'`;
    expect(row?.indexdef).toMatch(/USING gin/i);
    expect(row?.indexdef).toMatch(/to_tsvector/);
  });

  it("enforces business constraints", async () => {
    await sql
      .begin(async (tx) => {
        const userId = randomUUID();
        await tx`insert into auth.users (id) values (${userId}) on conflict do nothing`;
        await tx`insert into profiles (id, email) values (${userId}, ${`${userId}@example.com`})`;

        // citext: email uniqueness is case-insensitive
        await expect(
          tx.savepoint(
            (sp) =>
              sp`insert into profiles (id, email) values (${randomUUID()}, ${`${userId.toUpperCase()}@EXAMPLE.COM`})`,
          ),
        ).rejects.toThrow();

        const [product] = await tx<{ id: string }[]>`
        insert into products (external_id) values (${`ext-${userId}`}) returning id`;

        await expect(
          tx.savepoint((sp) => sp`update products set positioning = 'luxury' where id = ${product!.id}`),
        ).rejects.toThrow(/products_positioning_check/);

        await expect(
          tx.savepoint(
            (sp) => sp`insert into ad_campaigns (platform, product_id, status, daily_budget_minor, creative)
                     values ('meta', ${product!.id}, 'active', 5000, '{}')`,
          ),
        ).rejects.toThrow(/ad_campaigns_active_requires_approval/);

        const [order] = await tx<{ number: number }[]>`
        insert into orders (email, subtotal_minor, vat_minor, total_minor, shipping_address)
        values ('x@example.com', 1000, 153, 1000, '{}') returning number`;
        expect(Number(order!.number)).toBeGreaterThan(0);

        throw new RollbackSignal();
      })
      .catch((err: unknown) => {
        if (!(err instanceof RollbackSignal)) throw err;
      });
  });
});

class RollbackSignal extends Error {}
