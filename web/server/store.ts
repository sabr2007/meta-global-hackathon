// Private storage for users, scans and runs: a private Vercel Blob store in production, a folder on
// disk in local development. Browsers never get store credentials, only short-lived file URLs.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL_TTL_MS = 60 * 60 * 1000;

export interface UploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

export interface Store {
  readonly kind: 'blob' | 'disk';
  getBytes(key: string): Promise<Uint8Array | null>;
  putBytes(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
  /** A URL the browser can GET for one hour. */
  readUrl(key: string): Promise<string>;
  /** A URL the client can PUT a file to directly (large uploads skip the function body limit). */
  uploadTarget(key: string, contentType: string, maxBytes: number): Promise<UploadTarget>;
}

export async function getJson<T>(store: Store, key: string): Promise<T | null> {
  const bytes = await store.getBytes(key);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : null;
}

export function putJson(store: Store, key: string, value: unknown): Promise<void> {
  return store.putBytes(key, new TextEncoder().encode(JSON.stringify(value)), 'application/json');
}

function signingSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not configured');
  return secret;
}

/** HMAC signature for dev file URLs: `/api/files/<key>?exp=..&sig=..`. */
export function signFileUrl(key: string, expires: number): string {
  return createHmac('sha256', signingSecret()).update(`file:${key}:${expires}`).digest('base64url');
}

export function checkFileSignature(key: string, expires: number, signature: string): boolean {
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = Buffer.from(signFileUrl(key, expires));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function safeKey(key: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(key) || key.includes('..') || key.startsWith('/')) throw new Error(`unsafe storage key ${key}`);
  return key;
}

function diskStore(root: string): Store {
  const file = (key: string): string => path.join(root, safeKey(key));
  return {
    kind: 'disk',
    async getBytes(key) {
      try {
        return new Uint8Array(await readFile(file(key)));
      } catch {
        return null;
      }
    },
    async putBytes(key, bytes) {
      await mkdir(path.dirname(file(key)), { recursive: true });
      // Write then rename, so a concurrent reader never sees half a file.
      const temporary = `${file(key)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, file(key));
    },
    async list(prefix) {
      const base = file(prefix.endsWith('/') ? prefix : `${prefix}/`);
      const keys: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry);
          if ((await stat(full)).isDirectory()) await walk(full);
          else keys.push(path.relative(root, full).split(path.sep).join('/'));
        }
      };
      await walk(base);
      return keys.sort();
    },
    async remove(key) {
      await rm(file(key), { force: true });
    },
    async readUrl(key) {
      const expires = Date.now() + URL_TTL_MS;
      return `/api/files/${safeKey(key)}?exp=${expires}&sig=${signFileUrl(key, expires)}`;
    },
    async uploadTarget(key, contentType) {
      const expires = Date.now() + URL_TTL_MS;
      return {
        url: `/api/files/${safeKey(key)}?exp=${expires}&sig=${signFileUrl(key, expires)}`,
        method: 'PUT',
        headers: { 'content-type': contentType },
      };
    },
  };
}

function blobStore(): Store {
  // Imported lazily so local development does not need the package's credentials.
  const sdk = import('@vercel/blob');
  let token: Promise<{ clientSigningToken: string; delegationToken: string; validUntil: number }> | null = null;
  const signedToken = async (): Promise<{ clientSigningToken: string; delegationToken: string; validUntil: number }> => {
    const current = await token;
    if (!token || !current || current.validUntil < Date.now() + 5 * 60 * 1000) {
      const { issueSignedToken } = await sdk;
      token = issueSignedToken({ pathname: '*', operations: ['get', 'put'], validUntil: Date.now() + 2 * URL_TTL_MS });
    }
    return token as Promise<{ clientSigningToken: string; delegationToken: string; validUntil: number }>;
  };
  return {
    kind: 'blob',
    async getBytes(key) {
      const { get } = await sdk;
      const result = await get(safeKey(key), { access: 'private' });
      if (!result || result.statusCode !== 200) return null;
      return new Uint8Array(await new Response(result.stream).arrayBuffer());
    },
    async putBytes(key, bytes, contentType) {
      const { put } = await sdk;
      await put(safeKey(key), Buffer.from(bytes), { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true });
    },
    async list(prefix) {
      const { list } = await sdk;
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor, limit: 1000 });
        keys.push(...page.blobs.map((b) => b.pathname));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return keys.sort();
    },
    async remove(key) {
      const { del } = await sdk;
      await del(safeKey(key));
    },
    async readUrl(key) {
      const { presignUrl } = await sdk;
      const { presignedUrl } = await presignUrl(await signedToken(), {
        operation: 'get',
        pathname: safeKey(key),
        access: 'private',
        validUntil: Date.now() + URL_TTL_MS,
      });
      return presignedUrl;
    },
    async uploadTarget(key, contentType, maxBytes) {
      const { presignUrl } = await sdk;
      const { presignedUrl } = await presignUrl(await signedToken(), {
        operation: 'put',
        pathname: safeKey(key),
        access: 'private',
        validUntil: Date.now() + URL_TTL_MS,
        allowedContentTypes: [contentType],
        maximumSizeInBytes: maxBytes,
      });
      return { url: presignedUrl, method: 'PUT', headers: { 'content-type': contentType } };
    },
  };
}

let instance: Store | null = null;

export function store(): Store {
  instance ??= process.env.BLOB_READ_WRITE_TOKEN
    ? blobStore()
    : diskStore(process.env.AYNA_STORE_DIR ?? path.resolve(process.cwd(), '../data/store'));
  return instance;
}
