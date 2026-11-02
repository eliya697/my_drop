import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type PutResult = { key: string; url: string };

/** Where product media lives. Keys are POSIX paths such as `products/<id>/<hash>.webp`. */
export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<PutResult>;
  publicUrl(key: string): string;
}

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,500}$/i;

export function assertSafeKey(key: string): void {
  if (!KEY.test(key) || key.includes("..") || key.includes("//"))
    throw new Error(`unsafe storage key: ${key}`);
}

/** Cloudflare R2 through its S3-compatible API. Objects are immutable: content-addressed keys. */
export class R2Storage implements ObjectStorage {
  private readonly s3: S3Client;

  constructor(
    private readonly opts: {
      accountId: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      publicBaseUrl: string;
    },
  ) {
    this.s3 = new S3Client({
      region: "auto",
      endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<PutResult> {
    assertSafeKey(key);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return { key, url: this.publicUrl(key) };
  }

  publicUrl(key: string): string {
    return `${this.opts.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
  }
}

/** Filesystem storage for development and tests. */
export class LocalStorage implements ObjectStorage {
  private readonly root: string;

  constructor(
    root: string,
    private readonly publicBaseUrl: string,
  ) {
    this.root = resolve(root);
  }

  async put(key: string, body: Uint8Array, _contentType: string): Promise<PutResult> {
    assertSafeKey(key);
    const target = resolve(join(this.root, key));
    if (!target.startsWith(this.root + sep)) throw new Error(`storage key escapes root: ${key}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    return { key, url: this.publicUrl(key) };
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
  }
}
