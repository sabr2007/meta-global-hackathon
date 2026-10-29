// Small HTTP helpers shared by the routes: errors, JSON, body parsing, cookies and the live-call gate.

import { currentUser, type User } from './auth';
import { spend, type Allowance } from './quota';

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

export async function requireUser(request: Request): Promise<User> {
  const user = await currentUser(request);
  if (!user) throw new HttpError(401, 'Sign in to run Ayna live. The guest demo replays saved runs.');
  return user;
}

/** Live model calls need a signed-in user with allowance left today. */
export async function liveGate(request: Request, kind: Allowance): Promise<User> {
  const user = await requireUser(request);
  const left = await spend(user, kind);
  if (left < 0) throw new HttpError(429, `Daily limit reached for ${kind} calls. Replays stay free.`);
  return user;
}
