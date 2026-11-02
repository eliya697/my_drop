import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client";
import { CredentialDecryptionError, CredentialStore, decryptSecret, encryptSecret } from "./credentials";
import { runMigrations } from "./migrate";

const KEY = randomBytes(32).toString("base64");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and uses a fresh IV every time", () => {
    const a = encryptSecret("hello", KEY, "aliexpress");
    const b = encryptSecret("hello", KEY, "aliexpress");
    expect(a.equals(b)).toBe(false);
    expect(decryptSecret(a, KEY, "aliexpress")).toBe("hello");
  });

  it("detects tampering", () => {
    const blob = encryptSecret("hello", KEY, "aliexpress");
    blob[blob.length - 1]! ^= 0xff;
    expect(() => decryptSecret(blob, KEY, "aliexpress")).toThrow(CredentialDecryptionError);
  });

  it("fails with the wrong key", () => {
    const blob = encryptSecret("hello", KEY, "aliexpress");
    expect(() => decryptSecret(blob, randomBytes(32).toString("base64"), "aliexpress")).toThrow(
      CredentialDecryptionError,
    );
  });

  it("binds the ciphertext to its provider", () => {
    const blob = encryptSecret("hello", KEY, "aliexpress");
    expect(() => decryptSecret(blob, KEY, "meta")).toThrow(CredentialDecryptionError);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => encryptSecret("x", randomBytes(16).toString("base64"), "p")).toThrow(/32 bytes/);
  });
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("CredentialStore (integration)", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!, { max: 6 });
  });
  afterAll(async () => {
    await handle?.close();
  });

  type Secret = { token: string; n: number; expiresAt: number };
  const store = (provider: string) =>
    new CredentialStore<Secret>(handle.db, { provider, encryptionKey: KEY }, (s) => new Date(s.expiresAt));

  it("saves encrypted, loads decrypted, and records expiry", async () => {
    const provider = `test-${randomUUID()}`;
    const s = store(provider);
    expect(await s.load()).toBeNull();
    await s.save({ token: "super-secret-token", n: 1, expiresAt: Date.UTC(2030, 0, 1) });
    expect(await s.load()).toEqual({ token: "super-secret-token", n: 1, expiresAt: Date.UTC(2030, 0, 1) });

    const [row] = await handle.sql<{ secret_cipher: Buffer; expires_at: string }[]>`
      select secret_cipher, expires_at from integration_credentials where provider = ${provider}`;
    expect(row!.secret_cipher.toString("latin1")).not.toContain("super-secret-token");
    // drizzle configures the shared postgres-js client to return timestamps as strings
    expect(new Date(row!.expires_at).toISOString()).toBe("2030-01-01T00:00:00.000Z");
    await s.remove();
    expect(await s.load()).toBeNull();
  });

  it("serializes concurrent read-modify-write updates (no lost refresh)", async () => {
    const provider = `test-${randomUUID()}`;
    const s = store(provider);
    await s.save({ token: "t", n: 0, expiresAt: 0 });
    await Promise.all(
      Array.from({ length: 8 }, () =>
        s.update(async (current) => {
          await new Promise((r) => setTimeout(r, 5));
          return { ...current!, n: current!.n + 1 };
        }),
      ),
    );
    expect((await s.load())!.n).toBe(8);
  });

  it("serializes the very first write even before the row exists", async () => {
    const provider = `test-${randomUUID()}`;
    const s = store(provider);
    let creations = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        s.update(async (current) => {
          if (current) return current;
          creations++;
          await new Promise((r) => setTimeout(r, 10));
          return { token: "first", n: 1, expiresAt: 0 };
        }),
      ),
    );
    expect(creations).toBe(1);
  });
});
