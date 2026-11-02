import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Executor } from "./transitions";
import { integrationCredentials } from "./schema/integration";

/**
 * Secrets at rest: AES-256-GCM, a fresh 96-bit IV per write, and the provider name bound as
 * additional authenticated data so a ciphertext cannot be swapped between providers.
 * Layout: version(1) | iv(12) | tag(16) | ciphertext.
 */
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialDecryptionError extends Error {
  constructor(readonly provider: string) {
    super(`cannot decrypt credentials for ${provider} (wrong key or tampered data)`);
    this.name = "CredentialDecryptionError";
  }
}

function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("credentials key must be 32 bytes (base64)");
  return key;
}

export function encryptSecret(plaintext: string, base64Key: string, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(blob: Buffer, base64Key: string, aad: string): string {
  if (blob.length < 1 + IV_BYTES + TAG_BYTES || blob[0] !== VERSION) throw new CredentialDecryptionError(aad);
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const data = blob.subarray(1 + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(base64Key), iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialDecryptionError(aad);
  }
}

export type CredentialStoreOptions = { provider: string; encryptionKey: string };

/** Reads and writes one provider's encrypted JSON secret in `integration_credentials`. */
export class CredentialStore<T> {
  constructor(
    private readonly db: Executor,
    private readonly opts: CredentialStoreOptions,
    private readonly expiresAt: (value: T) => Date | null = () => null,
  ) {}

  async load(): Promise<T | null> {
    const [row] = await this.db
      .select({ cipher: integrationCredentials.secretCipher })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.provider, this.opts.provider));
    return row ? this.decode(row.cipher) : null;
  }

  async save(value: T): Promise<void> {
    await this.db.transaction((tx) => this.write(tx, value));
  }

  /**
   * Read-modify-write under a transaction-scoped advisory lock keyed on the provider, so
   * concurrent callers (several workers refreshing the same OAuth token) are serialized even
   * before the row exists.
   */
  async update(fn: (current: T | null) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credentials:${this.opts.provider}`}))`);
      const [row] = await tx
        .select({ cipher: integrationCredentials.secretCipher })
        .from(integrationCredentials)
        .where(eq(integrationCredentials.provider, this.opts.provider));
      const current = row ? this.decode(row.cipher) : null;
      const next = await fn(current);
      if (next !== current) await this.write(tx, next);
      return next;
    });
  }

  async remove(): Promise<void> {
    await this.db
      .delete(integrationCredentials)
      .where(eq(integrationCredentials.provider, this.opts.provider));
  }

  private async write(tx: Executor, value: T) {
    const secretCipher = encryptSecret(JSON.stringify(value), this.opts.encryptionKey, this.opts.provider);
    const expiresAt = this.expiresAt(value);
    await tx
      .insert(integrationCredentials)
      .values({ provider: this.opts.provider, secretCipher, expiresAt, refreshedAt: new Date() })
      .onConflictDoUpdate({
        target: integrationCredentials.provider,
        set: { secretCipher, expiresAt, refreshedAt: new Date() },
      });
  }

  private decode(cipher: Buffer): T {
    return JSON.parse(decryptSecret(Buffer.from(cipher), this.opts.encryptionKey, this.opts.provider)) as T;
  }
}
