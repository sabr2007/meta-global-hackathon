// Small HTTP helpers shared by the routes: errors, JSON, body parsing, cookies and the live-call gate.

import { currentUser, guestUser, type User } from './auth.js';
import { spend, type Allowance } from './quota.js';

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string; // segments starting with ':' are parameters
  run: (request: Request, params: Record<string, string>) => Promise<Response>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** Parse a JSON body and check that the named fields are present. */
export async function readJson<T>(request: Request, required: string[] = []): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'Expected a JSON body');
  }
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Expected a JSON object');
  const missing = required.filter((field) => (body as Record<string, unknown>)[field] === undefined);
  if (missing.length) throw new HttpError(400, `Missing field(s): ${missing.join(', ')}`);
  return body as T;
}

export function cookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** Pairing the iPhone scanner and its uploads need an account. */
export async function requireUser(request: Request): Promise<User> {
  const user = await currentUser(request);
  if (!user) throw new HttpError(401, 'This needs an account (the owner pairs the iPhone scanner).');
  return user;
}

export function limitMessage(user: User, kind: Allowance): string {
  return user.role === 'guest'
    ? 'Today’s live runs for visitors are used up (5 each, 30 for everyone a day). Replays stay free.'
    : `Daily limit reached for ${kind} calls. Replays stay free.`;
}

/** Live model calls are open to everyone, within the daily allowance (per account, or per visitor and for
 * all visitors together). */
export async function liveGate(request: Request, kind: Allowance): Promise<User> {
  const user = (await currentUser(request)) ?? guestUser(request);
  if ((await spend(user, kind)) < 0) throw new HttpError(429, limitMessage(user, kind));
  return user;
}
