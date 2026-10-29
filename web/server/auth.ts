// Accounts without a database: users are JSON records in the private store, passwords are scrypt
// hashes, sessions are HMAC-signed cookies, and an iPhone pairs with a one-time code for a device token.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getJson, putJson, store } from './store.js';

export const SESSION_COOKIE = 'ayna_session';
const SESSION_DAYS = 14;
const PAIR_CODE_MINUTES = 10;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const SCRYPT_COST = { N: 16384, r: 8, p: 1 };

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'judge' | 'member' | 'guest';
}

interface UserRecord extends User {
  salt: string;
  hash: string;
  created: string;
}

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error('AUTH_SECRET must be set (32+ characters)');
  return value;
}

const emailKey = (email: string): string => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32, SCRYPT_COST).toString('base64url');
}

export async function createUser(email: string, password: string, name: string, role: User['role']): Promise<User> {
  if (password.length < 10) throw new Error('password must be at least 10 characters');
  const salt = randomBytes(16).toString('base64url');
  const record: UserRecord = {
    id: emailKey(email).slice(0, 12),
    email: email.trim().toLowerCase(),
    name,
    role,
    salt,
    hash: hashPassword(password, salt),
    created: new Date().toISOString(),
  };
  await putJson(store(), `users/${emailKey(email)}.json`, record);
  return publicUser(record);
}

function publicUser(record: UserRecord): User {
  return { id: record.id, email: record.email, name: record.name, role: record.role };
}

export async function checkPassword(email: string, password: string): Promise<User | null> {
  const record = await getJson<UserRecord>(store(), `users/${emailKey(email)}.json`);
  // Hash even when the user is unknown, so timing does not reveal which emails exist.
  const expected = Buffer.from(record?.hash ?? hashPassword('x'.repeat(12), 'missing-user'));
  const given = Buffer.from(hashPassword(password, record?.salt ?? 'missing-user'));
  if (!record || expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return publicUser(record);
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function sessionCookie(user: User): string {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_DAYS * 86_400_000 })).toString('base64url');
  const secure = process.env.VERCEL ? '; Secure' : '';
  return `${SESSION_COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure}`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function userFromSession(value: string | null): User | null {
  if (!value) return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u: User; exp: number };
  return exp > Date.now() ? u : null;
}

/** A visitor without an account, known by a keyed hash of their IP address (Vercel sets x-real-ip): live
 * runs are open to everyone, and the daily allowance follows the visitor rather than a cookie. */
export function guestUser(request: Request): User {
  const ip = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  const id = createHmac('sha256', secret()).update(`guest:${ip}`).digest('hex').slice(0, 12);
  return { id: `guest-${id}`, email: '', name: 'Visitor', role: 'guest' };
}

interface DeviceRecord {
  user: User;
  name: string;
  created: string;
}

/** The signed-in user from the session cookie, or from a device token (iPhone uploads). */
export async function currentUser(request: Request): Promise<User | null> {
  const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const device = await getJson<DeviceRecord>(store(), `devices/${sha256(bearer)}.json`);
    return device?.user ?? null;
  }
  const header = request.headers.get('cookie') ?? '';
  const match = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${SESSION_COOKIE}=`));
  return userFromSession(match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null);
}

export async function createPairCode(user: User): Promise<{ code: string; expires: string }> {
  const bytes = randomBytes(6);
  const code = Array.from(bytes, (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join('');
  const expires = new Date(Date.now() + PAIR_CODE_MINUTES * 60_000).toISOString();
  await putJson(store(), `pair/${code}.json`, { user, expires });
  return { code, expires };
}

export async function redeemPairCode(code: string, deviceName: string): Promise<{ token: string; user: User } | null> {
  const key = `pair/${code.trim().toUpperCase()}.json`;
  if (!/^pair\/[A-Z0-9]{6}\.json$/.test(key)) return null;
  const entry = await getJson<{ user: User; expires: string }>(store(), key);
  if (!entry || Date.parse(entry.expires) < Date.now()) return null;
  await store().remove(key);
  const token = randomBytes(32).toString('base64url');
  const record: DeviceRecord = { user: entry.user, name: deviceName.slice(0, 80), created: new Date().toISOString() };
  await putJson(store(), `devices/${sha256(token)}.json`, record);
  return { token, user: entry.user };
}
