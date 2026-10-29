// Private storage for users, scans and runs: a Cloudflare R2 bucket in production, which the server and
// local tools such as the scan builder reach over R2's S3 API (AYNA_STORE=r2), or a folder on disk in
// local development. Browsers never get store credentials, only short-lived presigned or signed file
// URLs; the iPhone uploads its scan with a presigned PUT straight to the bucket.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';

export const URL_TTL_MS = 60 * 60 * 1000;
const URL_BUCKET_MS = 10 * 60 * 1000; // expiries round up to this, so a file keeps one URL (and one cache entry) for a while
const LIST_PAGE = 1000;

/** When a link signed now expires: at least URL_TTL_MS away, the same for every link signed in the same 10 minutes. */
export const linkExpiry = (): number => Math.ceil((Date.now() + URL_TTL_MS) / URL_BUCKET_MS) * URL_BUCKET_MS;

export interface UploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

export interface Store {
  readonly kind: 'r2' | 'disk';
  getBytes(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
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
  const signedUrl = (key: string): string => {
    const expires = linkExpiry();
    return `/api/files/${safeKey(key)}?exp=${expires}&sig=${signFileUrl(key, expires)}`;
  };
  return {
    kind: 'disk',
    async getBytes(key) {
      try {
        return new Uint8Array(await readFile(file(key)));
      } catch {
        return null;
      }
    },
    async exists(key) {
      try {
        return (await stat(file(key))).isFile();
      } catch {
        return false;
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
    readUrl: async (key) => signedUrl(key),
    uploadTarget: async (key, contentType) => ({ url: signedUrl(key), method: 'PUT', headers: { 'content-type': contentType } }),
  };
}

interface R2Settings {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The bucket's S3 keys from the environment (a token scoped to that one bucket), or null without them. */
function r2Settings(): R2Settings | null {
  const { R2_ACCOUNT_ID: accountId, R2_BUCKET: bucket = 'ayna-store', R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  return accountId && accessKeyId && secretAccessKey ? { accountId, bucket, accessKeyId, secretAccessKey } : null;
}

const amzDate = (ms: number): string => new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, '');

function r2Store(settings: R2Settings): Store {
  const client = new AwsClient({ accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey, service: 's3', region: 'auto' });
  const base = `https://${settings.accountId}.r2.cloudflarestorage.com/${settings.bucket}`;
  const url = (key: string): string => `${base}/${safeKey(key)}`;
  const call = async (key: string, init: RequestInit = {}): Promise<Response> => {
    const response = await client.fetch(url(key), init);
    if (!response.ok && response.status !== 404) throw new Error(`R2 ${init.method ?? 'GET'} ${key}: ${response.status} ${await response.text()}`);
    return response;
  };
  /** A presigned URL for one request on one key, valid for `seconds` from `signedAt`. */
  const presign = async (key: string, seconds: number, signedAt: number, init: RequestInit = {}): Promise<string> => {
    const target = new URL(url(key));
    target.searchParams.set('X-Amz-Expires', String(Math.round(seconds)));
    return (await client.sign(target.toString(), { ...init, aws: { signQuery: true, datetime: amzDate(signedAt) } })).url;
  };
  return {
    kind: 'r2',
    async getBytes(key) {
      const response = await call(key);
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    },
    exists: async (key) => (await call(key, { method: 'HEAD' })).ok,
    async putBytes(key, bytes, contentType) {
      await call(key, { method: 'PUT', body: bytes as BodyInit, headers: { 'content-type': contentType } });
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const query = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': String(LIST_PAGE) });
        if (token) query.set('continuation-token', token);
        const response = await client.fetch(`${base}?${query}`);
        if (!response.ok) throw new Error(`R2 list ${prefix}: ${response.status} ${await response.text()}`);
        const xml = await response.text();
        keys.push(...Array.from(xml.matchAll(/<Key>([^<]+)<\/Key>/g), (match) => match[1]));
        token = xml.includes('<IsTruncated>true</IsTruncated>') ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : undefined;
      } while (token);
      return keys.sort();
    },
    async remove(key) {
      await call(key, { method: 'DELETE' });
    },
    // Every link signed in the same 10 minutes is identical, so the browser keeps one cache entry per file.
    async readUrl(key) {
      const signedAt = Math.floor(Date.now() / URL_BUCKET_MS) * URL_BUCKET_MS;
      return presign(key, (linkExpiry() - signedAt) / 1000, signedAt);
    },
    // Straight to the bucket: a phone's scan (up to 500 MB) never passes through the function.
    async uploadTarget(key, contentType) {
      const headers = { 'content-type': contentType };
      return { url: await presign(key, URL_TTL_MS / 1000, Date.now(), { method: 'PUT', headers }), method: 'PUT', headers };
    },
  };
}

let instance: Store | null = null;

export function store(): Store {
  if (!instance) {
    if (process.env.AYNA_STORE === 'r2') {
      const settings = r2Settings();
      if (!settings) throw new Error('AYNA_STORE=r2 needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
      instance = r2Store(settings);
    } else {
      instance = diskStore(process.env.AYNA_STORE_DIR ?? path.resolve(process.cwd(), '../data/store'));
    }
  }
  return instance;
}
